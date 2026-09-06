# syntax=docker/dockerfile:1
# =============================================================================
# apps/server/Dockerfile —— 一包三入口（api / sync / worker），build context = 仓库根
# 契约（.github/workflows/backend.yml 头、infra/docker/docker-compose.yml）：
#   ARG SERVICE=api|sync 决定 CMD；worker 复用 api 镜像并由 compose 覆盖 command: node dist/worker.js
#   USER 10001:10001；镜像内有 wget；只写 /tmp；Node 24.20.0（A2）
# =============================================================================
FROM node:24.20.0-alpine3.22 AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter ./apps/server... 

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY tsconfig.base.json ./
RUN pnpm --filter ./apps/server... run build \
 && pnpm --filter ./apps/server deploy --prod --legacy /out \
 && cp -r apps/server/dist /out/dist

FROM node:24.20.0-alpine3.22 AS runtime
ARG SERVICE=api
ENV NODE_ENV=production TZ=UTC SERVICE=${SERVICE}
# busybox 自带 wget（healthcheck 契约）；tini 由 compose init: true 提供
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app -h /app app
WORKDIR /app
COPY --from=build --chown=10001:10001 /out /app
USER 10001:10001
EXPOSE 3000 4000
CMD ["sh", "-c", "exec node dist/${SERVICE}.js"]
