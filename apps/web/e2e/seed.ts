// Shared self-seeding helper for M6 browser specs: creates an admin session
// (SQL), imports+commits+publishes a work through the real pipeline, and
// cleans up afterwards. Requires the local stack (api + worker + web).
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { expect } from '@playwright/test';

const API = 'http://localhost:3000';
const FIXTURES = fileURLToPath(new URL('../../../m0/fixtures/txt', import.meta.url));

export interface Seed {
  adminCookie: string;
  pool: Pool;
  publish(fixture: string, title: string, opts?: { tags?: string[] }): Promise<string>;
  cleanup(): Promise<void>;
}

export async function seedEnv(SUFFIX: string): Promise<Seed> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://ebook_api:dev-api-pass@127.0.0.1:5432/ebook_dev' });
  const email = `e2e-br-admin-${SUFFIX}@example.test`;
  await pool.query(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'admin')
     on conflict (email) do nothing`,
    [`e2e-br-${SUFFIX}`, email, 'x'], // session via SQL below; login not under test
  );
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `insert into app.sessions (id, user_id, expires_at)
     select $1, id, now() + interval '1 hour' from app.users where email = $2`,
    [createHash('sha256').update(token).digest('hex'), email],
  );
  const adminCookie = `ebook_session=${token}`;

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(API + path, {
      ...init,
      headers: { cookie: adminCookie, ...(init?.headers as Record<string, string> | undefined) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const [cat] = (await pool.query(
    `insert into app.categories (display_name) values ($1) returning id`,
    [`瀏覽器分類-${SUFFIX}`],
  )).rows as Array<{ id: string }>;

  const published: string[] = [];

  return {
    adminCookie,
    pool,
    async publish(fixture, title, opts) {
      const form = new FormData();
      form.append('file', new File([readFileSync(`${FIXTURES}/${fixture}`)], fixture));
      const up = await api('/api/admin/imports', { method: 'POST', body: form });
      expect(up.status).toBe(201);
      const importId: string = up.body.importId;
      let status = '';
      for (let i = 0; i < 60 && !['ready', 'review_required', 'failed'].includes(status); i++) {
        await new Promise((r) => setTimeout(r, 500));
        status = (await api(`/api/admin/imports/${importId}`)).body.status;
      }
      expect(status).not.toBe('failed');
      const commit = await api(`/api/admin/imports/${importId}/commit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, workType: 'serial' }),
      });
      expect(commit.status).toBe(200);
      const workId: string = commit.body.workId;
      await pool.query(`insert into app.work_categories (work_id, category_id) values ($1,$2) on conflict do nothing`, [workId, cat.id]);
      for (const tag of opts?.tags ?? []) {
        const [t] = (await pool.query(`insert into app.tags (display_name) values ($1) returning id`, [`${tag}-${SUFFIX}`])).rows as Array<{ id: string }>;
        await pool.query(`insert into app.work_tags (work_id, tag_id) values ($1,$2) on conflict do nothing`, [workId, t.id]);
      }
      await pool.query(`update app.works set serial_status='ongoing', visibility='public' where id=$1`, [workId]);
      const pub = await api(`/api/admin/works/${workId}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `br-${workId}` }, body: '{}',
      });
      expect(pub.status).toBe(200);
      published.push(workId);
      return workId;
    },
    async cleanup() {
      for (const w of published) {
        await pool.query(`delete from app.reading_progress where work_id=$1`, [w]);
        await pool.query(`delete from app.bookmarks where work_id=$1`, [w]);
        await pool.query(`delete from app.user_chapter_reads where chapter_id in (select id from app.chapters where work_id=$1)`, [w]);
        await pool.query(`delete from app.user_follows where work_id=$1`, [w]);
        await pool.query(`delete from app.user_library where work_id=$1`, [w]);
        await pool.query(`update app.chapters set head_revision_id=null where work_id=$1`, [w]);
        await pool.query(`delete from app.release_items where release_id in (select id from app.work_releases where work_id=$1)`, [w]);
        await pool.query(`delete from app.publication_events where work_id=$1`, [w]);
        await pool.query(`update app.works set active_release_id=null where id=$1`, [w]);
        await pool.query(`delete from app.work_releases where work_id=$1`, [w]);
        await pool.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w]);
        await pool.query(`delete from app.chapters where work_id=$1`, [w]);
        await pool.query(`delete from app.work_categories where work_id=$1`, [w]);
        await pool.query(`delete from app.work_tags where work_id=$1`, [w]);
        await pool.query(`update app.source_files set work_id=null where work_id=$1`, [w]);
        await pool.query(`update app.import_jobs set work_id=null where work_id=$1`, [w]);
        await pool.query(`delete from app.works where id=$1`, [w]);
      }
      await pool.query(`delete from app.apply_idempotency where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email=$1))`, [email]);
      await pool.query(`delete from app.import_items where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email=$1))`, [email]);
      await pool.query(`delete from app.import_jobs where requested_by_user_id in (select id from app.users where email=$1)`, [email]);
      await pool.query(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
      await pool.query(`delete from app.categories where id=$1`, [cat.id]);
      await pool.query(`delete from app.sessions where user_id in (select id from app.users where email=$1)`, [email]);
      await pool.query(`delete from app.users where email=$1`, [email]);
      await pool.end();
    },
  };
}
