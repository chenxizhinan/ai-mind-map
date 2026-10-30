# ai-mind-map 快速启动
# 端口使用固定的 5 位数冷门端口 47213（应用）/ 47214（bridge），避开常用端口段

PORT := 47213
BRIDGE_PORT := 47214

# Docker 部署参数（默认构建 x86_64 镜像；arm64 机器：make docker-build PLATFORM=linux/arm64）
DOCKER_IMAGE ?= ai-mind-map
TAG ?= latest
PLATFORM ?= linux/amd64
APP_PORT ?= 47213
BRIDGE_PORT ?= 47214
MINDMAPS_DIR ?= ./mindmaps

export DOCKER_IMAGE TAG PLATFORM APP_PORT BRIDGE_PORT MINDMAPS_DIR

.PHONY: help install dev demo bridge bridge-file mcp build build-web build-server test typecheck clean \
        docker-build docker-up docker-down docker-logs docker-restart docker-clean

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## 安装依赖
	npm install

dev: ## 一键全启：脑图应用(:47213) + bridge 多文档服务(:47214)（Ctrl-C 同时退出）
	npx concurrently -n app,bridge -c blue,green \
		"npx vite apps/app --port $(PORT) --strictPort" \
		"npx tsx packages/mcp-server/src/bridge-cli.ts --dir ./mindmaps --port $(BRIDGE_PORT)"

demo: ## 只启动脑图应用（不连 bridge 也可用，AI 抽屉/多文档同步不可用）
	npx vite apps/app --port $(PORT) --strictPort

bridge: ## 只启动 bridge（多文档模式，文档目录 ./mindmaps）
	npx tsx packages/mcp-server/src/bridge-cli.ts --dir ./mindmaps --port $(BRIDGE_PORT)

bridge-file: ## 只启动 bridge（单文档兼容模式，文档 ./testcases.mindmap.json）
	npx tsx packages/mcp-server/src/bridge-cli.ts --file ./testcases.mindmap.json --port $(BRIDGE_PORT)

mcp: ## 启动 MCP server（stdio 多文档模式，供 Claude 连接）
	npx tsx packages/mcp-server/src/cli.ts --dir ./mindmaps

build: build-web build-server ## 构建生产产物（web 静态 + bridge bundle）
build-web: ## 构建前端静态产物（apps/app/dist）
	npm run build:web
build-server: ## 打包 bridge 服务为单文件（dist-server/bridge.mjs）
	npm run build:server

test: ## 运行测试
	npx vitest run

typecheck: ## 类型检查
	npm run typecheck

clean: ## 清理依赖与构建产物
	rm -rf node_modules apps/app/dist dist-server

# ---------- Docker 部署 ----------
# 默认构建 x86_64；Apple Silicon / ARM 构建或运行：
#   make docker-build PLATFORM=linux/arm64
# 数据持久化：宿主机目录挂载进容器（默认 ./mindmaps），可用 MINDMAPS_DIR 覆盖

docker-build: ## 构建镜像（默认 linux/amd64；PLATFORM 可覆盖）
	docker build --platform $(PLATFORM) \
		--build-arg VITE_BRIDGE_URL=http://localhost:$(BRIDGE_PORT) \
		-t $(DOCKER_IMAGE):$(TAG) .

docker-up: docker-build ## 构建并后台启动 web + bridge（compose）
	docker compose up -d
	@echo "应用:   http://localhost:$(APP_PORT)"
	@echo "bridge: http://localhost:$(BRIDGE_PORT)（脑图目录: $(MINDMAPS_DIR)）"

docker-down: ## 停止并移除容器（数据保留在宿主机目录）
	docker compose down

docker-logs: ## 跟踪容器日志
	docker compose logs -f --tail=100

docker-restart: ## 重建镜像并重启全部容器
	docker compose up -d --build --force-recreate

docker-clean: docker-down ## 停止并删除镜像（数据保留）
	docker rmi $(DOCKER_IMAGE):$(TAG) 2>/dev/null || true
