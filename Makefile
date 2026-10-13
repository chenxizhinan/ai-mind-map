# ai-mind-map 快速启动
# 端口使用固定的 5 位数冷门端口 47213（应用）/ 47214（bridge），避开常用端口段

PORT := 47213
BRIDGE_PORT := 47214

.PHONY: help install dev demo bridge bridge-file mcp test typecheck clean

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

test: ## 运行测试
	npx vitest run

typecheck: ## 类型检查
	npm run typecheck

clean: ## 清理依赖与构建产物
	rm -rf node_modules package-lock.json
