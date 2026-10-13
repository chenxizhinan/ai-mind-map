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

把下面的提示词存为 `.claude/skills/gen-testmap/SKILL.md`，之后 `/gen-testmap <方案或代码目录>` 一句话完成：

```markdown
---
name: gen-testmap
description: 从需求/方案/代码生成测试用例脑图（ai-mind-map MCP）
---

# 测试用例脑图生成

1. 调用 ai-mind-map 的 get_test_methods 获取设计方法约束
2. 读取目标材料（$ARGUMENTS：文档路径或代码目录）
3. create_tree 建根（根名 = 产品/方案名）
4. 按被测对象拆模块（folder，一级/二级），每个模块下按
   维度→功能点→测试点→用例 四级展开（参考 get_test_methods 的结构约束）
5. 每条用例（case）props 必须含：
   - priority: P0-P3（P0=阻塞发布）
   - expected: 可观察、可判定的预期结果
   - remark: 来源引用（文档章节 / 代码文件:行）
   - precondition / steps: 有前置或明确步骤时填写
6. 全部挂载后 query_tree 自查一遍数量与层级，向用户报告：模块数、用例数、P0 数
```

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
- **MCP/脚本生成必须自己分配节点 id**（`n_0001` 递增）；空 id 的文档在浏览器里无法
  选中/编辑节点。
