# syntax=docker/dockerfile:1

# ---------- 构建阶段：依赖安装 + 前端构建 + bridge 打包 ----------
# 默认构建 linux/amd64；docker-compose.yml 已固定 platform，
# 其他架构：docker build --platform=linux/arm64 ...
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /repo

# 先复制清单文件，最大化利用层缓存
COPY package.json package-lock.json ./
COPY apps/app/package.json apps/app/
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/renderer/package.json packages/renderer/
# BuildKit 缓存挂载：npm 下载缓存跨构建复用（package.json 变更也不重新下载 tarball）
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# 复制源码并构建：web 静态产物 + bridge 单文件 bundle
COPY . .
# bridge 地址可在构建期注入；留空时前端按浏览器当前 hostname 推导。
ARG VITE_BRIDGE_URL=
ENV VITE_BRIDGE_URL=$VITE_BRIDGE_URL
RUN npm run build:web \
 && npm run build:server

# ---------- 运行时 ----------
# alpine：运行时只有 node + 两个纯 JS 文件（无原生模块），基础镜像体积约为 bookworm-slim 的一半
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    WEB_ROOT=/app/web \
    PORT=8080 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=47214 \
    DATA_DIR=/data/mindmaps

# web 静态产物 + bridge 单文件 bundle（无运行时 node_modules 依赖）
COPY --from=build /repo/apps/app/dist /app/web
COPY --from=build /repo/apps/app/serve.mjs /app/serve.mjs
COPY --from=build /repo/dist-server/bridge.mjs /app/bridge.mjs
# 技能目录：bridge 按需读取（get_skill / /skill），平台更新技能后重建镜像即生效
COPY --from=build /repo/.agents/skills/test-case-designer /app/skill

# 脑图存储目录（docker-compose 挂载持久化）
RUN mkdir -p /data/mindmaps

EXPOSE 8080 47214

# 默认启动静态站点；bridge 服务由 docker-compose 以 command 覆盖启动
CMD ["node", "serve.mjs"]
