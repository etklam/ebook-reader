FROM node:26-bookworm-slim@sha256:3ffc19ea878019d9e9ae8971732ad4a03cda44f167107173174b60ed7c65bed3

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
