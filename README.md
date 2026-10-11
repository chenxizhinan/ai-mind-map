# ai-mind-map

AI 原生的测试用例脑图工具：Claude 通过 MCP 读取代码与方案文档、增量构建上万节点的用例树，本地应用提供万级节点流畅渲染、用例编辑与评审批注。

## 架构

```
packages/
  core/         数据模型：文档、可扩展节点类型注册表、树操作、双侧地图布局
  mcp-server/   stdio MCP server：增量构建/修订/批注/导出工具，持久化到单个 JSON 文件
  renderer/     canvas 渲染器：视口裁剪、rAF 脏帧调度、分支着色渐细连线、多行文本
apps/
  app/          主应用：右键菜单、撤销重做、键盘操作、拖拽移动、缩放工具条
```

对应设计文档：`docs/design/architecture-draft.md`（数据模型、MCP 工具面、渲染选型依据在 `docs/research/`）。

## 快速开始

```bash
make install   # 安装依赖
make demo      # 启动脑图应用（固定冷门端口 47213，避开常用端口）
```

打开 http://localhost:47213，约 12k 演示节点。其他命令：`make help` 查看（`make mcp` 启动 MCP server、`make test`、`make typecheck`）。

### 交互一览

- **浏览**：滚轮/拖拽平移，Ctrl/⌘+滚轮缩放（左下角工具条：±/适应全图）
- **选择**：单击选中（侧边面板显示路径/类型/详情），空白单击取消
- **编辑**：双击或 F2 编辑文本（DOM overlay，输入法隔离）；Enter 提交、Esc 取消
- **结构**：Tab/Insert 新建子节点，Enter 新建同级，Del/Backspace 删除子树
- **导航**：←→ 进入/退出层级，↑↓ 兄弟循环导航，Space 折叠/展开
- **拖拽**：按住节点拖到目标节点上释放 = 移动子树（防环校验）
- **右键菜单**：新建/编辑/展开折叠/复制粘贴/类型转换/删除
- **撤销重做**：⌘Z / ⌘⇧Z（100 步 JSON 快照）
- **复制粘贴子树**：⌘C / ⌘V
- **持久化**：localStorage 自动保存/恢复（展开状态一并保存）

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
- [ ] MCP 与应用的文件监听实时刷新（当前 app 用「加载 JSON」按钮导入）
- [ ] AI 对话式生成（复用 MCP 底座）

## XMind / Markdown 互转

- **导出 .xmind**：Zen 格式（XMind 2020+ 可直接打开）。用例优先级 → 原生 `priority-1..4` marker；用例的前置条件/步骤/预期结果 → 子主题（对齐 MeterSphere v3 中文键约定，可被其 XMind 导入流程直接识别）。
- **导入 .xmind**：兼容新格式（content.json）与 XMind 8 旧格式（content.xml）；带 priority marker 或「前置条件：/步骤描述：」字段子主题的叶子节点自动识别为 `case` 类型，字段归入 props。
- **导出 Markdown**：幕布式大纲——根 = `#`，二级 = `##`（超过 6 级用嵌套列表），case 字段为列表项（`**[P1]**` 前缀、`前置条件：`、`步骤 1：`、`预期：`）。
- **导入 Markdown**：标题建节点、缩进列表还原层级、字段行归入 props，往返语义一致。

应用顶部按钮可直接体验：导入 XMind / 导出 XMind / 导出 MD。MCP 侧提供 `export_xmind` 与 `export_markdown` 工具（Node 文件系统读写）。
