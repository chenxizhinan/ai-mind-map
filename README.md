# ai-mind-map

AI 原生的测试用例脑图工具：Claude 通过 MCP 读取代码与方案文档、增量构建上万节点的用例树，本地应用提供万级节点流畅渲染、用例编辑与评审批注。

## 架构

```
packages/
  core/         数据模型：文档、可扩展节点类型注册表、树操作、布局
  mcp-server/   stdio MCP server：增量构建/修订/批注工具，持久化到单个 JSON 文件
  renderer/     canvas 渲染器：视口裁剪、rAF 脏帧调度、DOM overlay 编辑定位
apps/
  demo/         演示应用：12k 节点演示数据、侧边面板（用例信息/批注）
```

对应设计文档：`docs/design/architecture-draft.md`（数据模型、MCP 工具面、渲染选型依据在 `docs/research/`）。

## 快速开始

```bash
npm install
npm run demo        # 打开 http://localhost:5173，约 12k 演示节点
```

交互：滚轮平移、Ctrl/⌘+滚轮缩放、单击选中（侧边面板编辑）、双击改文本、节点右缘 `+N` 胶囊折叠/展开。

## 连接 Claude（MCP）

在 Claude Code 的 `.mcp.json` 或 Claude Desktop 配置中加入：

```json
{
  "mcpServers": {
    "ai-mind-map": {
      "command": "npx",
      "args": [
        "-y", "tsx",
        "<仓库绝对路径>/packages/mcp-server/src/cli.ts",
        "--file", "/path/to/testcases.mindmap.json"
      ]
    }
  }
}
```

Claude 可用的工具：

| 工具 | 作用 |
|---|---|
| `create_tree` | 建树/重置根节点 |
| `add_subtree` | 在父节点下增量追加子树（批量建用例的主要入口），返回分配的节点 id |
| `update_node` | 改节点文本/业务字段（经 NodeType 校验） |
| `move_subtree` / `delete_subtree` | 移动/删除（防环校验） |
| `query_tree` | 读树（按类型过滤、limit 截断，避免超大响应） |
| `add_annotation` / `list_annotations` / `reply_annotation` / `resolve_annotation` | 评审批注闭环：人批注 → Claude 读批注 → 修订 → 回批注 |

## 节点类型扩展

core 不硬编码业务语义。注册自定义类型即可：

```ts
import { NodeTypeRegistry } from '@ai-mind-map/core';

const registry = new NodeTypeRegistry();
registry.register({
  name: 'risk',
  label: '风险项',
  leafOnly: true,
  role: 'leaf',
  normalizeProps: (input) => ({ level: input.level ?? 'low' }),
  describe: (props) => [{ text: props.level, tone: 'warning' }],
});
```

`normalizeProps` 是唯一写入路径的校验关卡（MCP 工具与表单都经过它）；`describe` 返回画布徽标。随包附带的 `folder`/`case` 只是示例类型。

## 测试

```bash
npm test          # 29 个测试：类型注册表、树操作、布局（含 10k 节点预算）、MCP 工具
npm run typecheck # 全 workspace 严格类型检查
```

## 当前状态与路线

- [x] core 数据模型 + 可扩展类型注册表
- [x] MCP server（stdio，增量构建 + 批注）
- [x] canvas 渲染器（12k 节点演示流畅；视口裁剪 + 默认折叠）
- [x] 侧边面板（用例信息 / 批注线程）
- [ ] XMind 导出（MeterSphere/禅道/TestLink 约定已调研，见 `docs/research/`）
- [ ] MCP 与应用的文件监听实时刷新（当前 demo 用「加载 JSON」按钮导入）
- [ ] AI 对话式生成（复用 MCP 底座）
