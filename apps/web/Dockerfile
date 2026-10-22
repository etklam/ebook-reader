FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build
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
