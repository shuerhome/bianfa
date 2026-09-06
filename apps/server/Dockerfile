# syntax=docker/dockerfile:1
# =============================================================================
# apps/server/Dockerfile —— 一包五入口（api / sync / worker / migrate / auth-bootstrap）+ Web 面静态产物（public/web），build context = 仓库根
# 契约（.github/workflows/backend.yml 头、infra/docker/docker-compose.yml）：
#   ARG SERVICE=api|sync 决定 CMD；worker 复用 api 镜像并由 compose 覆盖 command: node dist/worker.js
#   USER 10001:10001；镜像内有 wget；只写 /tmp；Node 24.20.0（A2）
# =============================================================================
FROM node:24.20.0-alpine3.23 AS base
# CI=true：pnpm 无 TTY 时不弹确认（modules 目录清理等）
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tokens/package.json packages/tokens/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Web 面（apps/web）与 api 同镜像：api 进程同源托管其产物（apps/server/src/http/web-static.ts）
# pnpm 11：路径式过滤（./apps/server...）不会把 workspace 依赖包装进来（实测 packages/* 没有 node_modules），必须用包名
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@bianfa/server..." --filter "@bianfa/web..."

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/tokens packages/tokens
COPY packages/ui packages/ui
COPY apps/web apps/web
COPY apps/server apps/server
COPY tsconfig.base.json ./
# 先构建 Web 面（tokens → ui → web），再构建 api（scripts/build.mjs 把 apps/web/dist 复制到 apps/server/public/web）
# turbo 按依赖图顺序构建 shared → tokens → ui → web → server（pnpm 的递归 run 在过滤下不保证顺序，实测 web 先于 tokens 跑而失败）
RUN pnpm turbo run build --filter=@bianfa/web --filter=@bianfa/server \
 && pnpm --filter @bianfa/server deploy --prod --legacy /out \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/server/public /out/public

FROM node:24.20.0-alpine3.23 AS runtime
ARG SERVICE=api
ENV NODE_ENV=production TZ=UTC SERVICE=${SERVICE}
# busybox 自带 wget（healthcheck 契约）；tini 由 compose init: true 提供
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app -h /app app
WORKDIR /app
COPY --from=build --chown=10001:10001 /out /app
USER 10001:10001
EXPOSE 3000 4000
CMD ["sh", "-c", "exec node dist/${SERVICE}.js"]
