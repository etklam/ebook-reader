FROM node:26-bookworm-slim@sha256:3ffc19ea878019d9e9ae8971732ad4a03cda44f167107173174b60ed7c65bed3 AS build
WORKDIR /repo
RUN npm install --global pnpm@10.32.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY m0/package.json ./m0/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web typecheck && pnpm --filter web build

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
COPY ops/nginx/ebook.conf /etc/nginx/conf.d/default.conf
COPY ops/nginx/security-headers.conf /etc/nginx/ebook-security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
