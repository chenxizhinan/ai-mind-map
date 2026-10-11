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
| `export_xmind` / `export_markdown` | 导出 .xmind（Zen 格式）/ 幕布式 Markdown 大纲 |

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
- [x] MCP server（stdio，增量构建 + 批注 + 导出）
- [x] canvas 渲染器（12k 节点演示流畅；视口裁剪 + 默认折叠）
- [x] 侧边面板（用例信息 / 批注线程）
- [x] XMind 导入导出 + 幕布式 Markdown 互转（见下）
- [ ] MCP 与应用的文件监听实时刷新（当前 demo 用「加载 JSON」按钮导入）
- [ ] AI 对话式生成（复用 MCP 底座）

## XMind / Markdown 互转

- **导出 .xmind**：Zen 格式（XMind 2020+ 可直接打开）。用例优先级 → 原生 `priority-1..4` marker；用例的前置条件/步骤/预期结果 → 子主题（对齐 MeterSphere v3 中文键约定，可被其 XMind 导入流程直接识别）。
- **导入 .xmind**：兼容新格式（content.json）与 XMind 8 旧格式（content.xml）；带 priority marker 或「前置条件：/步骤描述：」字段子主题的叶子节点自动识别为 `case` 类型，字段归入 props。
- **导出 Markdown**：幕布式大纲——根 = `#`，二级 = `##`（超过 6 级用嵌套列表），case 字段为列表项（`**[P1]**` 前缀、`前置条件：`、`步骤 1：`、`预期：`）。
- **导入 Markdown**：标题建节点、缩进列表还原层级、字段行归入 props，往返语义一致。

demo 顶部按钮可直接体验：导入 XMind / 导出 XMind / 导出 MD。MCP 侧提供 `export_xmind` 与 `export_markdown` 工具（Node 文件系统读写）。
