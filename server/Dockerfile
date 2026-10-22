FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe

ENV NODE_ENV=production
WORKDIR /app

RUN npm install --global pnpm@10.32.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY m0/package.json ./m0/package.json
RUN pnpm install --frozen-lockfile --prod=false --filter server...

COPY server ./server
COPY m0/fixtures ./m0/fixtures
RUN pnpm --filter server typecheck && pnpm --filter server test
WORKDIR /app/server
EXPOSE 3000
USER node
CMD ["pnpm", "start"]
