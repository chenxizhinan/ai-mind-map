# ai-mind-map 快速启动
# 端口使用固定的 5 位数冷门端口 47213（避开常用端口段）

PORT := 47213

.PHONY: help install demo dev mcp bridge bridge-file test typecheck clean

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## 安装依赖
	npm install

demo: ## 启动脑图应用（http://localhost:$(PORT)）
	npx vite apps/app --port $(PORT) --strictPort

dev: demo ## 同 demo

mcp: ## 启动 MCP server（stdio 多文档模式，供 Claude 连接）
	npx tsx packages/mcp-server/src/cli.ts --dir ./mindmaps

bridge: ## 启动桥接服务（多文档模式，http://localhost:47214，文档目录 ./mindmaps）
	npx tsx packages/mcp-server/src/bridge-cli.ts --dir ./mindmaps --port 47214

bridge-file: ## 启动桥接服务（单文档兼容模式，文档 ./testcases.mindmap.json）
	npx tsx packages/mcp-server/src/bridge-cli.ts --file ./testcases.mindmap.json --port 47214

test: ## 运行测试
	npx vitest run

typecheck: ## 类型检查
	npm run typecheck

clean: ## 清理依赖与构建产物
	rm -rf node_modules package-lock.json
