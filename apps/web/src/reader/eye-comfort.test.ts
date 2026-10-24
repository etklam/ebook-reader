// Scheduled theme + warm overlay (RV-016).
//
// The contrast cases below are the point of this file. The warm overlay
// multiplies the whole reader, which means it darkens the background AND the
// text, and whether that nets out to better or worse contrast is not something
// anyone can tell by looking at a hex value. The theme colours are declared in
// oklch in reader.css, so the maths here converts them the same way the
// browser does and then applies the same multiply the compositor will.
//
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, isNightHour, normalizeSettings, resolveTheme, WARMTH_FILTERS,
  type Theme, type Warmth,
} from './reader-state.ts';

// --- schedule ---------------------------------------------------------------

test('the night window wraps midnight, and an empty window is never night', () => {
  // the ordinary case: 19:00 → 07:00
  for (const hour of [19, 23, 0, 3, 6]) assert.equal(isNightHour(hour, 19, 7), true, `${hour}`);
  for (const hour of [7, 12, 18]) assert.equal(isNightHour(hour, 19, 7), false, `${hour}`);
  // a window that does not wrap
  assert.equal(isNightHour(13, 12, 15), true);
  assert.equal(isNightHour(15, 12, 15), false, 'the end hour is exclusive');
  // equal ends mean "never", not "always": nobody asks for permanent dark by
  // setting the same hour twice
  for (const hour of [0, 9, 23]) assert.equal(isNightHour(hour, 9, 9), false, `${hour}`);
});

test('schedule is a theme source of its own, and degrades to the OS without a clock', () => {
  const clock = (hour: number) => ({ hour, nightFrom: 19, nightTo: 7 });
  assert.equal(resolveTheme('schedule', false, clock(22)), 'dark');
  assert.equal(resolveTheme('schedule', false, clock(10)), 'light');
  // the OS preference does not get a vote once the clock has one
  assert.equal(resolveTheme('schedule', true, clock(10)), 'light');
  // ...and a caller with no clock falls back to the OS rather than pinning
  // every reader to light
  assert.equal(resolveTheme('schedule', true), 'dark');
  assert.equal(resolveTheme('schedule', false), 'light');
  // the other choices are untouched by the clock
  assert.equal(resolveTheme('sepia', true, clock(22)), 'sepia');
  assert.equal(resolveTheme('system', true, clock(10)), 'dark');
});

// --- settings are untrusted input ------------------------------------------

test('warmth and the night hours survive junk from storage or the account sync', () => {
  const bad = normalizeSettings({
    v: 2, theme: 'schedule', warmth: 9, nightFrom: -3, nightTo: 99,
  });
  assert.equal(bad.theme, 'schedule');
  assert.equal(bad.warmth, DEFAULT_SETTINGS.warmth);
  assert.equal(bad.nightFrom, DEFAULT_SETTINGS.nightFrom);
  assert.equal(bad.nightTo, DEFAULT_SETTINGS.nightTo);
  // a fractional hour is not a time, so it falls back rather than rounding to
  // a neighbouring hour the reader never chose
  assert.equal(normalizeSettings({ v: 2, nightFrom: 6.5 }).nightFrom, DEFAULT_SETTINGS.nightFrom);
  // valid values pass through, including the edges
  const good = normalizeSettings({ v: 2, warmth: 3, nightFrom: 0, nightTo: 23 });
  assert.equal(good.warmth, 3);
  assert.equal(good.nightFrom, 0);
  assert.equal(good.nightTo, 23);
  // settings written before this feature existed get the defaults, not undefined
  const old = normalizeSettings({ v: 2, theme: 'dark', fontSize: 20 });
  assert.equal(old.warmth, 0);
  assert.equal(old.nightFrom, DEFAULT_SETTINGS.nightFrom);
});

// --- contrast ---------------------------------------------------------------

/** oklch → sRGB 0-255, the same transform the browser applies to reader.css. */
function oklch(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return linear.map((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  }) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** mix-blend-mode: multiply, which is exactly what the overlay does. */
function multiply(base: [number, number, number], over: [number, number, number]): [number, number, number] {
  return base.map((v, i) => Math.round((v * over[i]) / 255)) as [number, number, number];
}

function parseRgb(css: string): [number, number, number] {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// --bg and --ink straight out of reader.css for each theme
const THEME_COLOURS: Record<Theme, { bg: [number, number, number]; ink: [number, number, number] }> = {
  light: { bg: oklch(1, 0, 0), ink: oklch(0.225, 0.014, 77) },
  sepia: { bg: oklch(0.945, 0.027, 86), ink: oklch(0.285, 0.022, 62) },
  dark: { bg: oklch(0.155, 0, 0), ink: oklch(0.878, 0.009, 77) },
};

test('body text stays above AAA in every theme at every warmth level', () => {
  for (const theme of ['light', 'sepia', 'dark'] as const) {
    const { bg, ink } = THEME_COLOURS[theme];
    for (const level of [0, 1, 2, 3] as Warmth[]) {
      const filter = WARMTH_FILTERS[level];
      const over = filter ? parseRgb(filter) : null;
      const ratio = over
        ? contrast(multiply(bg, over), multiply(ink, over))
        : contrast(bg, ink);
      // 7:1 is AAA for body text. The reading surface is nothing but body
      // text, so AA would be the wrong bar to clear here.
      assert.ok(ratio >= 7, `${theme} at warmth ${level} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('warmth costs contrast but never inverts or collapses it', () => {
  for (const theme of ['light', 'sepia', 'dark'] as const) {
    const { bg, ink } = THEME_COLOURS[theme];
    const ratios = ([0, 1, 2, 3] as Warmth[]).map((level) => {
      const filter = WARMTH_FILTERS[level];
      if (!filter) return contrast(bg, ink);
      const over = parseRgb(filter);
      return contrast(multiply(bg, over), multiply(ink, over));
    });
    for (let i = 1; i < ratios.length; i++) {
      // each step may only cost contrast, never gain it — a level that read as
      // "warmer" while being sharper would mean the table is wrong
      assert.ok(ratios[i] <= ratios[i - 1] + 0.01,
        `${theme}: warmth ${i} (${ratios[i].toFixed(2)}) is not dimmer than ${i - 1} (${ratios[i - 1].toFixed(2)})`);
    }
    // and the total cost stays modest: the strongest filter must not throw
    // away more than a third of the theme's contrast
    assert.ok(ratios[3] >= ratios[0] * 0.66,
      `${theme}: warmth 3 drops contrast from ${ratios[0].toFixed(2)} to ${ratios[3].toFixed(2)}`);
  }
});

test('warmth 0 paints nothing at all', () => {
  // an overlay of rgb(255,255,255) is a no-op that still costs a compositing
  // layer across the whole reader on every frame
  assert.equal(WARMTH_FILTERS[0], null);
  for (const level of [1, 2, 3] as Warmth[]) assert.match(WARMTH_FILTERS[level]!, /^rgb\(/);
});
