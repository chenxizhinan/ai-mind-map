# 用 AI 把测试用例生成到脑图 —— 连接与提示词指南

脑图应用提供三种 AI 接入方式，按场景选用。**目标：以后不需要写转换脚本，一句话让 AI 读方案/代码 → 用例直接出现在脑图上。**

---

## 方式一：AI 助手抽屉（零配置，最快）

1. `make bridge` 启动桥接服务（多文档模式，端口 47214，文档目录 `./mindmaps/`）
2. 打开脑图应用（`make demo`，端口 47213）
3. 点右上角「✦ AI 助手」，直接对话：

```
读取 /path/to/BYOS验证与测试用例-测试.md，
用 create_document 新建一篇「BYOS 验证与测试用例」脑图，
把每一章作为一级模块、每个小节作为二级模块、表格里的每条用例作为用例节点挂进去。
用例 props 带 priority（P0-P3）、expected（预期结果）、remark（原 ID + 场景分类）。
```

AI 现在具备文档管理能力：`list_documents`（列出现有文档）、`create_document`
（新建一篇，自动出现在应用首页）、`open_document`（按标题或 id 切换到指定文档
再更新）。说「生成一篇新脑图」会建新文档；说「更新 XX 那篇」会自动切换过去。

原理：抽屉走 bridge 的 `/ai/chat`，AI 在工具循环里自动调用 `create_tree` / `add_subtree` / `query_tree`，浏览器实时看到节点长出来。

**注意**：浏览器打开同一文档时，浏览器自动保存会以浏览器内容为准（800ms 防抖回写 bridge）。让 AI 生成前，先在浏览器里打开目标文档或空白文档。

## 方式二：MCP 接入 Claude Code / 其他客户端（可跨项目）

在客户端的 MCP 配置里加：

```json
{
  "mcpServers": {
    "ai-mind-map": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-server/src/cli.ts", "--dir", "/path/to/mindmaps"],
      "cwd": "/Users/txlei/workspace/owner/code/ai-mind-map"
    }
  }
}
```

之后 Claude Code 里可以直接说：

```
用 ai-mind-map 把 /path/to/测试.md 的用例整理成一篇新脑图：
- create_document 建新文档（标题取方案名）
- 按文档章节 add_subtree 逐模块挂载（folder 结构：模块 → 小节 → case）
- 每条 case 的 props: priority/expected/remark(含原ID)
- 完成后 list_documents 确认
要更新已有脑图时：open_document（标题或 id）后再操作。
```

**可用工具**（AI 会自动选用）：

| 工具 | 用途 |
|---|---|
| `list_documents` | 列出全部文档（标记当前激活） |
| `create_document` | 新建文档并激活（出现在应用首页） |
| `open_document` | 按标题/id 切换激活文档 |
| `create_tree` | 重置当前文档根节点 |
| `add_subtree` | 批量挂子树（模块/用例的主要入口） |
| `update_node` / `delete_subtree` / `move_subtree` | 增删改移 |
| `query_tree` | 读树（按类型过滤，分页） |
| `add_annotation` / `list_annotations` | 批注（AI 自查/评审意见） |
| `get_test_methods` | 取测试设计方法库（生成用例前先调用，约束质量） |
| `export_xmind` / `export_markdown` | 导出 .xmind / 大纲 .md |

## 方式三：Skill（团队复用，一次配置）

仓库已内置完整的 **test-case-designer** Skill（Codex 标准：`.agents/skills/test-case-designer/`），
覆盖工作模式、测试分析、追溯、层级、用例设计方法、字段规范和 **P0-P3 优先级规则**，
并带质量门禁脚本 `scripts/validate-test-cases.js`。

```bash
# Codex（repo 级）：本仓库内直接可用（.agents/skills 会被自动发现）
# 让 Codex 执行：选择模式 → 测试分析 → 建立追溯 → 设计用例 → MCP 写入 → Review
#   “按需求文档设计手工测试用例脑图”
#   “只读评审现有用例的覆盖缺口、追溯与重复问题”
# 质量门禁（写入后运行）：
node .agents/skills/test-case-designer/scripts/validate-test-cases.js <mindmap.json> --strict
```

结构：

```text
.agents/skills/test-case-designer/
├── SKILL.md                     # 入口：边界、主流程、MCP 写入步骤、输出报告
├── agents/openai.yaml           # Codex 元数据与依赖（ai-mind-map MCP）
├── references/
│   ├── case-writing-standard.md # 字段/标题/详情/备注/禁止内部实现词
│   ├── hierarchy-standard.md    # 层级主轴和导航结构决策规则
│   ├── operation-modes.md       # 新建/补充/重组/只读评审的权限和退出条件
│   ├── priority-standard.md     # P0-P3 定义、判断维度、定级规则与门禁
│   ├── test-analysis-standard.md # 测试条件、风险、预言、数据与待确认项
│   ├── test-design-methods.md   # 状态机/场景/等价类/判定表/故障注入/兼容矩阵…
│   ├── traceability-standard.md # 来源→测试条件→稳定用例 ID
│   └── review-checklist.md      # 全量 Review 清单与退出标准
└── scripts/
    └── validate-test-cases.js   # 确定性校验：字段/追溯/重复/空业务分组/…
```

其他客户端复用时应直接读取同一 `SKILL.md` 和按需引用 `references/`，不要复制一套会独立漂移的简化规则。

### 优先级定义（P0–P3）

| 优先级 | 定义 | 执行要求 |
|---|---|---|
| P0 | 失败会阻塞发布，且没有可接受的绕行、降级或风险接受方案 | 每次发布必须执行，失败即停止发布 |
| P1 | 高业务风险或高发生概率；若发布必须显式接受风险并提供缓解方案 | 完整回归必须执行，失败需修复或显式风险接受 |
| P2 | 次要功能、低概率边界或影响范围有限 | 常规回归执行，按风险决定是否阻塞 |
| P3 | 极低概率、防御性或探索性场景 | 定向或周期性执行，通常不阻塞发布 |

定级依据 = 业务影响 × 发生概率 × 恢复难度 × 数据/安全风险 × 是否版本核心目标（不是开发工作量）。完整规则见
`.agents/skills/test-case-designer/references/priority-standard.md`。AI 生成用例时（bridge/MCP）这些规则已内置于 system prompt。

## 一次性转换：表格型测试文档 → 脑图 JSON

文档已是「ID/级别/场景分类/标题/预期」表格时，不用 AI，直接转：

```bash
npx tsx scripts/md-tests-to-mindmap.ts <测试用例.md> <输出.json> --root "脑图根名"
```

输出 JSON 在脑图应用首页「导入文件…」导入，或作为 bridge 的 `--file` 使用。

脚本规则：`##` 章 → 一级模块、`###` 节 → 二级模块；表头自适应（支持 5 列/6 列变体）；
场景分类自动映射到用例类型（正常→功能、边界→边界、异常→异常、权限/安全→安全、
隔离→流程、兼容/恢复→兼容、性能/容量→性能、并发→数据）；原始 ID 与分类进备注。

## 已知坑

- **已修复（多文档模式）**：bridge `changed` 事件带 docId，应用只对「当前打开的那篇」
  拉内容，其余只更新首页卡片；每篇文档独立回声抑制，浏览器不再覆盖 AI 写的其他文档。
  单文档兼容模式（`make bridge-file`）仍保留旧的覆盖语义。
- **节点 props 白名单**：case 只接受 `priority/caseType/precondition/steps/expected/
  tags/remark` + 样式字段（color/icon/method/exec）。自定义字段（如 scenario）会被
  静默丢弃，写进 `remark` 才能保留。
- **执行状态** `props.exec` 取值 `pass`（通过）/ `blocked`（阻塞）/ `fail`（失败）；
  不写 = 未执行（默认，画布与大纲不展示）。其他取值会被静默丢弃。
- **长文本放详情**：folder（模块/路径）节点标题保持简短，长背景、数据清单、参考材料写
  `props.detail`（应用右侧「详情」可完整查看/编辑），短备注仍用 `props.note`。
- **清理/删除**：删节点用 `delete_subtree`（单节点/子树），批量删用 `delete_nodes`
  （返回 `{removedIds, errors}`，某个 id 失败不影响其它）；删整篇文档用 `delete_document`
  （`--dir` 模式删除对应 `.mindmap.json`，不可恢复）。根节点不可删除；请勿绕过 MCP
  直接改文件。
- **MCP/脚本生成建议自己分配节点 id**（`n_0001` 递增）；缺失或重复的 id 在文档加载时
  会被自动补成唯一编号。
