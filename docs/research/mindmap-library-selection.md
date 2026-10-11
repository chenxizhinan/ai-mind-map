# 开源脑图（思维导图）项目技术选型调研报告

> 调研目标：评估 GitHub 上开源脑图项目，选择适合实现「通过 AI 对话自动生成脑图」功能的渲染库/应用（用户在聊天界面输入一句话 → LLM 生成结构化内容 → 前端渲染为可交互思维导图）。
>
> 数据核实日期：**2026-10-11**。Star 数、最近更新时间均通过 GitHub REST API（`api.github.com/repos/<owner>/<repo>`）当日核实；npm 版本与发布时间通过 npm registry API 核实；数据格式与 API 能力均以仓库源码 / README / 官方文档一手来源为准。
>
> 说明：简单核查（如 grep 源码确认某方法存在）标注"源码核实"；未能找到一手依据的结论标注「未验证」。

---

## 1. 调研背景与评估维度

「AI 对话生成脑图」的核心链路是：

```
用户一句话 → LLM 流式输出结构化文本 → 前端解析为树/图数据 → 渲染为可交互脑图 → （可选）用户继续编辑/追加 AI 修改
```

因此评估维度定为：

1. **定位**：纯渲染库 / 带编辑器的库 / 完整应用（产品）
2. **数据格式**：Markdown / JSON 树 / Mermaid / FreeMind XML / XMind(.xmind) 等的导入导出能力
3. **AI 集成能力**：项目自身是否内置 AI 生成插件/示例；第三方是否已基于它做了 AI 产品
4. **流式/渐进渲染**：LLM 流式输出时能否"边生成边渲染"，以及这样做的代价（全量 re-render vs 增量 patch、节点 uid 稳定性、动画连贯性）
5. **维护状态**：star 数（2026-10-11 核实）、最近 push/release、issue 活跃度
6. **开源许可证**：MIT / BSD / Apache / GPL / AGPL / 自定义商业限制，直接影响商用
7. **技术栈与二开成本**：Vue/React/框架无关；学习曲线；是否需要后端

---

## 2. 候选项目总览对比表

（Star 与最近更新为 2026-10-11 经 GitHub API 核实的当前值）

| 项目 | 仓库 | 定位 | 技术栈 | 数据格式 | AI 支持 | 流式渲染 | Star | 最近更新 | 许可证 |
|---|---|---|---|---|---|---|---|---|---|
| markmap | [markmap/markmap](https://github.com/markmap/markmap) | 渲染库（markdown→交互 SVG） | 框架无关（d3） | Markdown（唯一输入） | 无内置；第三方大量基于它做 AI 产品 | 好：transform() 可对增量 markdown 反复调用，setData 有 key 复用+动画 | 13,158 | 2026-09-12 | MIT |
| simple-mind-map | [wanglin2/mind-map](https://github.com/wanglin2/mind-map) | 库 + Web 应用（客户端闭源） | 框架无关（示例 Vue2） | JSON 树（原生）、Markdown/XMind/Txt 导入、PNG/SVG/PDF/JSON/MD/Txt 导出 | Web 端源码内置 AI 生成（AiCreate.vue，经客户端代理调火山方舟） | 好：官方 AI 场景即"轮询 + updateData"逐步渲染 | 12,808 | 2026-08-02 | MIT（库）；客户端与部分插件不开源 |
| mind-elixir | [SSShooter/mind-elixir-core](https://github.com/SSShooter/mind-elixir-core) | 纯核心库（带交互编辑） | 框架无关 | JSON 树（原生）、SVG/PNG/HTML 导出、markdown 仅做节点内富文本 | 官方提供 `npx skills add` AI 集成指南 | 中：`refresh(data)` 全量刷新，无官方流式示例（未验证性能） | 3,177 | 2026-10-03 | MIT |
| jsmind | [hizzgdev/jsmind](https://github.com/hizzgdev/jsmind) | 纯库（canvas+svg） | 框架无关 | JSON（node_tree/node_array）、FreeMind XML | 无 AI 相关内容 | 弱：`jm.show()` 全量重绘为主，支持 add_node 逐个加（可行但无动画保证，未验证体验） | 3,793 | 2026-05-18 | BSD-3-Clause |
| mermaid mindmap | [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) | 图表 DSL 渲染（mindmap 是其中一种图） | 框架无关 | Mermaid 语法（缩进式文本大纲） | 无内置；社区项目用 GPT 生成 mermaid mindmap | 差：Jison 语法器 + `mermaid.render` 整体重渲染，半截语法直接 parse error（源码核实，见 4.4） | 90,603 | 2026-10-11 | MIT |
| React Flow | [xyflow/xyflow](https://github.com/xyflow/xyflow) | 通用节点图引擎 | React / Svelte | 完全自定义（nodes/edges 数组） | 无内置；官方有 mind map 教程 | 自建：完全可控，但树布局、折叠等都要自己实现 | 38,631 | 2026-10-09 | MIT |
| AntV X6 | [antvis/X6](https://github.com/antvis/X6) | 通用图编辑引擎 | 框架无关（React Shape 可选） | 自定义 JSON（nodes/edges） | 无内置；MindGeniusAI 等基于 X6 做 AI 脑图 | 自建：配 @antv/hierarchy mindmap 布局，更新走全量或手动 diff | 6,723 | 2026-08-11 | MIT |
| AntV G6 | [antvis/G6](https://github.com/antvis/G6) | 图可视化框架（内置 mindmap 布局） | 框架无关 | 自定义 JSON（树数据） | 无内置 | 中：5.x 有数据更新 API，但整树布局+动画的流式体验需自行调优（未验证） | 12,326 | 2026-10-10 | MIT |
| WiseMapping | [wisemapping/wisemapping-open-source](https://github.com/wisemapping/wisemapping-open-source) | 完整应用（Java 后端 + JS 前端） | Java + 自研 JS | 自有 XML、FreeMind 导入、SVG/PNG 导出 | 无 | 未验证（无公开 AI/流式文档） | 315 | 2026-10-08 | WPL（Apache 2.0 + "powered by WiseMapping" 强制署名） |
| blink-mind | [awehook/blink-mind](https://github.com/awehook/blink-mind) | React 思维导图库 | React + immutable.js | 自有 JSON | 无 | 未验证 | 363 | 2022-02-10（基本停更） | MIT |
| kityminder-core | [fex-team/kityminder-core](https://github.com/fex-team/kityminder-core) | 渲染/编辑核心库 | 框架无关（Angular 生态） | JSON（自有协议）、第三方协议需扩展包 | 无 | 未验证；上游已停止维护 | 1,378 | 2024-03-04（npm 最后发布 2018-08） | BSD-3-Clause |
| drawnix（补充发现） | [plait-board/drawnix](https://github.com/plait-board/drawnix) | 开源白板应用（含脑图） | React + Plait 框架 | 自有 JSON(.drawnix)、markdown 转脑图、mermaid 转流程图、PNG 导出 | 无 AI | 未验证 | 14,935 | 2026-09-08 | MIT |

npm 月下载量（近 30 天，2026-10-11 核实，用于衡量真实使用度）：`markmap-lib` ≈ 55.9 万、`markmap-view` ≈ 57.2 万、`mind-elixir` ≈ 10.4 万、`simple-mind-map` ≈ 2.4 万、`jsmind` ≈ 1.2 万。mermaid 与 `@xyflow/react` 均为千万级。

---

## 3. 逐项目详细分析

### 3.1 markmap（markmap/markmap）

- **定位**：纯渲染库。把 Markdown 解析为树数据（`markmap-lib`），再用 `markmap-view` 渲染成交互式 SVG（缩放、拖拽、折叠、高亮）。不做节点级富编辑（无内置的增删改 UI），定位是"只读展示 + 折叠交互"。
- **数据格式**：**只吃 Markdown**（另支持 HTML 解析器 `markmap-html-parser`、JSON options frontmatter）。导出依赖周边：`markmap-cli` 可生成独立 HTML；SVG/PNG 需自己从 DOM 导。不支持反向导出 XMind/FreeMind。
- **AI 集成能力**：官方仓库无 AI 代码，但 markmap 是"AI 生成脑图"生态事实上的标准渲染层：
  - [kongkongyo/Ai-Markmap](https://github.com/kongkongyo/Ai-Markmap)（440 star，MIT，纯前端单文件）：用 OpenAI 兼容 API 生成 markdown → `markmap-lib@0.15.3` + `markmap-view@0.15.3` 渲染（其 README 技术栈章节明示）。
  - [jinzcdev/markmap-mcp-server](https://github.com/jinzcdev/markmap-mcp-server)（290 star，MIT）：把 markdown 转成 markmap 交互图的 MCP server。
  - [linus-sch/Mind-Map-Wizard](https://github.com/linus-sch/Mind-Map-Wizard)（359 star，CC BY-NC 4.0，注意非商用）：AI 生成 markdown 大纲（其 `prompt.txt` 要求 LLM 输出 `#`/`##`/`###` 标题层级），自研 SVG 渲染器。
  - markmap 官方 [try it out 页面](https://markmap.js.org/repl) 即时转换。
- **流式渲染（关键结论，有一手源码依据）**：
  - `markmap-lib` 的 `Transformer.transform(content)` 是纯函数式转换：markdown-it 渲染成 HTML → `buildTree` 构建节点树，返回 `{ root, features }`（源码 [transform.ts](https://github.com/markmap/markmap/blob/master/packages/markmap-lib/src/transform.ts)，`transform()` 方法体直接可见）。**该方法无状态累积要求，可对流式到达的部分 markdown 反复调用**——每次都从头 parse，但因 markdown-it 解析极快（毫秒级），在节流（如每 100~200ms 或每个 chunk）下完全可行。
  - `markmap-view` 的 `Markmap.setData(data)`（[view.ts](https://github.com/markmap/markmap/blob/master/packages/markmap-view/src/view.ts)）：`_initializeData` 为每个节点生成 `state.key = parentId.id + simpleHash(content)`，`renderData()` 里用 `.data(nodes, d => d.state.key)` 做 D3 keyed join——**内容未变的已有节点复用同一 DOM， enter/update/exit 带 transition 动画**。这意味着反复 `setData` 时旧节点不闪、新节点平滑生长，正是流式渲染需要的行为（[官方文档：两步流程 transform → view 渲染](https://markmap.js.org/docs/packages--markmap-lib)）。
  - 佐证用例：真实项目 [i-am-alice/3rd-devs](https://github.com/i-am-alice/3rd-devs) 的 `audio-map-frontend/src/app.ts` 在前端用 `transformer.transform(markmapSyntax)` + `Markmap` 实例渲染 LLM 产出的 markdown 脑图。
  - 限制：markdown 标题层级只有 6 级（官方 [FAQ](https://markmap.js.org/docs/faq) 明确解释），更深层级需用嵌套列表；未闭合的 markdown 段（如半行文字）会被解析成一个尚不完整的节点，多次 re-parse 会造成最后一节点的文本不断变化——视觉上这是可接受的"打字机效果"，但折叠状态等 payload 需要注意（`fold` 状态按 key 复用，节点文本变化会改变 key 导致折叠状态重置——此细节为源码推断，未做实测）。
- **维护状态**：star 13,158（2026-10-11）；最近 push 2026-09-12；monorepo 最近一次 npm 发布 2025-06（markmap-lib/view 0.18.12，[npm registry](https://registry.npmjs.org/markmap-lib)）；open issues 57，社区（Discussions）活跃。维护节奏偏慢但稳定，下载量大（月 55 万+）。
- **许可证**：MIT（全部子包）。
- **技术栈/二开成本**：框架无关，核心是 d3 + SVG foreignObject；有官方 React/Vue [示例](https://markmap.js.org/docs/markmap)（StackBlitz）。接入成本极低：`new Transformer()` + `Markmap.create(svg, opts, root)` 两个调用即可跑通。**不需要布局、连线、样式等任何定制就能得到美观结果**，这是它对"AI 生成预览"场景最大的优势。若需要"可编辑脑图"，markmap 本体不提供，需换库或自建编辑层。

### 3.2 simple-mind-map（wanglin2/mind-map）

- **定位**：**两部分**：① 开源的 JS 库（`simple-mind-map` npm 包）+ Vue2 写的 Web 思维导图应用；② **闭源**的桌面客户端与部分插件（README 明确"客户端和插件代码不开源，正在积极开发维护中"，[README](https://github.com/wanglin2/mind-map#客户端插件)）。
- **数据格式**：原生数据是 JSON 树（`{data: {text, ...}, children: [...]}`）。内置 [parse](https://github.com/wanglin2/mind-map/tree/main/simple-mind-map/src/parse)：`markdown.js`/`toMarkdown.js`（互转）、`xmind.js`（XMind 导入）。`Export.js` 插件导出 png/pdf/svg/json/smm/md/txt（源码核实方法列表）。README 称支持导入 XMind、FreeMind、Markdown、Txt、Xlsx，导出 PNG、XMind、SVG、PDF、Markdown、Txt、Xlsx、FreeMind、Mermaid、Html（客户端能力，部分插件闭源）。
- **AI 集成能力（有官方一手实现）**：Web 应用源码内含 `web/src/pages/Edit/components/AiCreate.vue`、`AiChat.vue`、`AiConfigDialog.vue`、`utils/ai.js`。`AiCreate.vue` 的实现（[源码](https://github.com/wanglin2/mind-map/blob/main/web/src/pages/Edit/components/AiCreate.vue)）：
  - LLM 走**客户端本地代理**（`fetch('http://localhost:${port}/ai/...')`，默认对接火山方舟，issue #1281 中作者确认其余模型支持有限）；
  - 流式回调中把已有内容按 `\n` 分割、**丢掉最后一段未完成文本**，得到"安全 markdown"，用 `transformMarkdownTo()`（`simple-mind-map/src/parse/markdownTo`）转树；
  - 循环渲染：监听 `node_tree_render_end` 事件，渲染完成后 `mindMap.updateData(treeData)` 触发下一轮——即官方自己就是用「markdown → 树 → updateData 循环」实现 AI 流式脑图；
  - `addUid()` 按「父 uid + 节点文本」复用 uid，保证流式重渲染时节点 id 稳定。
  - 相关 issue 佐证：[#702 AI如何实时生成思维导图](https://github.com/wanglin2/mind-map/issues/702)（作者 wanglin2："markdown转json需要自己实现，一个个字不推荐，很耗性能"）、[#1116 探索对AI的支持](https://github.com/wanglin2/mind-map/issues/1116)（方案：火山引擎接口 + 客户端代理）。**注意：AI 功能入口在闭源客户端侧更完整，开源 Web 里的 AiCreate.vue 依赖本地客户端代理才能工作**。
- **流式渲染**：如上，官方验证过「分批 markdown → transformMarkdownTo → updateData」路线；`updateData()`（[index.js 源码](https://github.com/wanglin2/mind-map/blob/main/simple-mind-map/index.js)）走 `renderer.setData(data) + render() + addHistory()`，是全量替换数据重渲染，性能上"一个个字不推荐"，按节点/按行批量喂是官方实践。
- **维护状态**：star 12,808（2026-10-11）；npm `simple-mind-map@0.14.0-fix.3`（2026-07-07 发布）；GitHub release 0.20.0 为客户端版本号（2026-08-03），库代码随仓库更新；最近 push 2026-08-02；open issues 108。README 明示库与 Web 部分已进入"**低维护状态**"，精力转向闭源客户端——这是商用选型的重要风险信号。
- **许可证**：库为 MIT，但注意：客户端、以及客户端专属插件（如 AI 对接、部分导入导出）不开源；README 亦有多处"客户端/插件闭源"表述。二次开发只可依赖开源库部分。
- **技术栈/二开成本**：库本身框架无关（SVG），官方 Web 应用是 Vue2 + ElementUI。文档站点 [wanglin2.github.io/mind-map-docs](https://wanglin2.github.io/mind-map-docs/) + 旧版 SPA 文档。功能全面（多结构布局、主题、大纲、公式、拖拽等），但 API 面大、文档以中文为主，二开成本中等。

### 3.3 mind-elixir（SSShooter/mind-elixir-core）

- **定位**：纯核心库（自带交互编辑：拖拽、快捷键、节点编辑），框架无关（README 明示 "framework agnostic"，提供 React/Vue3 CodeSandbox 示例）。
- **数据格式**：原生 JSON 树（[readme 数据结构章节](https://github.com/SSShooter/mind-elixir-core/blob/master/readme.md)：`{topic, id, style, tags, children: [...]}`）；导出 `getData()/getDataString()`；导入 `init(data)`/`refresh(data)`；导出 SVG/PNG/HTML。**markdown 只是节点内富文本渲染钩子**（`markdown: text => ...` 自定义解析函数，README "Markdown Support" 章节），**不提供 markdown→树 的整体转换**，需自行实现（与 simple-mind-map 相反）。
- **AI 集成能力**：官方 README 有"**Build with AI**"章节，提供 `npx skills add ssshooter/mind-elixir-core` 安装面向 AI 编程助手的集成指南（2026 年新增，README 第 75-85 行）——说明作者积极拥抱 AI 辅助开发，但项目本身不带 AI 生成功能。第三方有基于 mind-elixir 的 AI 产品（如 bubu-LZY/my-mindmap-agent 提及基于 Simple Mind Map；mind-elixir 生态中 AI 生成示例多为博客级，未发现高 star 官方示例——未验证）。
- **流式渲染**：`refresh(data)` 为全量替换；没有官方流式 API。理论上可轮询调 `refresh`，但节点动画/uid 稳定性无官方保证（未验证）。
- **维护状态**：star 3,177；最近 push 2026-10-03（非常活跃）；v5.15.1 release 2026-08-05，npm `6.0.0-next.4`（2026-08-11，v6 大版本开发中，[v5 breaking changes wiki](https://github.com/SSShooter/mind-elixir-core/wiki/Breaking-Change#500)）；open issues 仅 10。
- **许可证**：MIT。
- **技术栈/二开成本**：零依赖、框架无关、体积小，API 简单（`new MindElixir(options); mind.init(data)`）。二开成本低，但要自建 markdown→树 转换器和流式节奏控制。

### 3.4 jsmind（hizzgdev/jsmind）

- **定位**：纯 JS 库（canvas + svg），显示 + 基础编辑。
- **数据格式**：官方文档（[docs/en/1.usage.md](https://github.com/hizzgdev/jsmind/blob/master/docs/en/1.usage.md)）："3 formats are supported by jsMind: `node_tree`, `node_array` and `freemind`"，加载与导出均支持这三种。
- **AI 集成能力**：无（仓库与文档均无 AI 相关内容）。
- **流式渲染**：`jm.show(mind)` 全量展示；也可 `jm.add_node(...)` 逐个添加（[docs/en/3.operation.md](https://github.com/hizzgdev/jsmind/blob/master/docs/en/3.operation.md)），逐节点喂流式数据技术上可行，但布局重算与动画表现无官方保证（未验证）。
- **维护状态**：star 3,793；最近 push 2026-05-18；v0.9.1 release 2025-12-15；open issues 仅 1（作者响应式维护，节奏平缓）。npm 月下载约 1.2 万。
- **许可证**：BSD-3-Clause（LICENSE 文件 + README 均明示）。
- **技术栈/二开成本**：框架无关、轻量。文档明确禁止未经许可转载/修改其文档。功能较基础（富文本、多主题、拖拽体验弱于前三者），二开成本低但上限也低。

### 3.5 mermaid 的 mindmap

- **定位**：mermaid 是文本→图渲染引擎，mindmap 是其一种图类型（v9.4.0 起内置，lazy loading）。
- **数据格式**：Mermaid 缩进式文本大纲（官方 [mindmap 文档](https://mermaid.js.org/syntax/mindmap.html)：`mindmap / Root / A / B` 层级缩进），支持节点形状、图标（iconify）、Markdown Strings、`tidy-tree` 布局（v12 配 `layout: tidy-tree`）。**没有 JSON 树输入/导出**——文本语法即唯一源；导出 SVG/PNG。不能导入 XMind/FreeMind。
- **AI 集成能力**：无内置。社区参考实现：[florian-kalisch/auto-mindmapping](https://github.com/florian-kalisch/auto-mindmapping)（69 star，MIT）用 GPT-3.5/4 生成 mermaid mindmap 文本再渲染——证明了"LLM 直接产 mermaid 语法"路线可行，但见下方流式问题。
- **流式渲染（关键结论，有依据）**：**不适合流式**。依据：
  1. mermaid 的解析器是 Jison 生成的 LALR 语法器（[mindmap-definition.ts](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/diagrams/mindmap/mindmap-definition.ts) `import parser from './parser/mindmap.jison'`），`mermaid.render(id, text)` 对**整段文本**做 parse——半截语法会抛解析错误（官方 [API 文档](https://mermaid.js.org/config/usage.html)：parse 失败时抛错或返回 false，**不存在部分成功/部分渲染模式**）。
  2. `mermaid.render()` 每次全量生成新 SVG，没有跨渲染的节点复用/动画机制（对比 markmap-view 的 keyed join），流式重渲染 = 整图闪烁重画。
  3. mindmap 图类型本身标注 experimental（[官方文档](https://mermaid.js.org/syntax/mindmap.html)："Mindmap: This is an experimental diagram for now. The syntax and properties can change in future releases. The syntax is stable except for the icon integration"）。
  - 缓解办法（社区常见做法，未验证为最佳实践）：只在 LLM 输出完整段落/完整行后再 parse，或对 parse 失败时回退显示上一次成功的版本——但这只是"伪流式"。
- **维护状态**：star 90,603；v12.1.0 release 2026-10-02；极活跃（open issues 1,485）。
- **许可证**：MIT。
- **技术栈/二开成本**：框架无关。若产品只需要"静态展示一张生成的脑图"，mermaid 上手最快；若要交互脑图体验（折叠、编辑、流式生长），不合适。

### 3.6 React Flow（xyflow）

- **定位**：通用节点图 UI 引擎（React/Svelte），不是脑图库。
- **数据格式**：自定义 `nodes`/`edges` 数组，无脑图概念。
- **官方 mindmap 支持**：官方教程 [Build a mind map app with React Flow](https://reactflow.dev/learn/tutorials/mind-map-app-with-react-flow)（配套仓库 [xyflow/react-flow-mindmap-app](https://github.com/xyflow/react-flow-mindmap-app)，126 star）：自定义 node（input + Handle）、`onConnectEnd` 拖拽到空白处新建子节点、Zustand 存状态。这是"教你搭"的教程，不是可直接复用的脑图组件。
- **AI/流式**：无内置。社区案例：[Zhaimiaoyizhi/TurnMap](https://github.com/Zhaimiaoyizhi/TurnMap)（39 star，MIT，浏览器扩展：把 ChatGPT/Claude 等对话实时转成可编辑脑图）依赖即 `@xyflow/react@12.8.5`（其 package.json 核实）。用 React Flow 做流式脑图 = 自己实现：树布局（如 d3-flextree）、增量更新（`setNodes`）、动画。成本最高、自由度也最高。
- **维护状态**：star 38,631；非常活跃（2026-10-09 push；月下载 5,700 万级）。
- **许可证**：MIT（xyflow 仓库；React Flow v11 起为 MIT，其"React Flow Pro"仅是付费示例订阅，核心库 MIT）。
- **技术栈/二开成本**：绑定 React（或 Svelte Flow 对应 Svelte）。适合把"脑图"做成产品核心体验、需要完全自定义节点视觉/交互/协作的团队。

### 3.7 AntV X6 / AntV G6

- **X6**：通用图编辑引擎（SVG/HTML 节点，React/Vue shape 支持）。官方 mindmap 示例（[site/examples/layout/tree/demo/mindmap.ts](https://github.com/antvis/X6/blob/master/site/examples/layout/tree/demo/mindmap.ts)）= `@antv/hierarchy` 的 `Hierarchy.mindmap(data)` 算布局 + X6 画节点/边。数据是自定义 JSON（nodes/edges），无脑图语义，无 AI 支持。X6 本体活跃（v3.1.7，2026-03；push 2026-08-11）。
- **G6**：图可视化框架，v5 内置 mindmap 布局（[官方文档 Mindmap Tree](https://g6.antv.antgroup.com/manual/layout/mindmap-layout) 引 `@antv/hierarchy` mindmap，支持左右展开、考虑节点尺寸）。push 2026-10-10，v5.1.1（2026-04）。G6 更偏"可视化分析"，做可编辑脑图要自建编辑层。
- **AI 关联案例（有实证）**：[xianjianlf2/MindGeniusAI](https://github.com/xianjianlf2/MindGeniusAI)（283 star，**BSL 1.1 许可证**，非纯 OSI 开源）——AI agent 读 PDF 生成可编辑脑图，前端即 X6 + `@antv/hierarchy`（其 `apps/web/package.json` 核实），agent 侧用 Vercel AI SDK 工具循环按节点 id 做局部修改。
- **许可证**：均为 MIT。
- **结论**：阿里系图引擎质量高、文档全（中文友好），但没有开箱即用的"脑图应用"，树布局/折叠/编辑都要组合搭建；流式需自行做 diff 或全量 setGraph（未验证动画连贯性）。适合已有 AntV 技术栈的团队。

### 3.8 WiseMapping（wisemapping-open-source）

- **定位**：完整应用（Java/Spring 后端 + 自研 JS 前端），类 Mindmeister 产品。
- **数据格式**：自有 XML（WiseMapping 格式），支持 FreeMind 导入、SVG/PNG 导出（README/官网，未逐项实测）。
- **AI/流式**：无。
- **维护状态**：star 315；持续小步更新（push 2026-10-08）。
- **许可证（重要）**：**WPL（WiseMapping Public License）**——[LICENSE.md](https://github.com/wisemapping/wisemapping-open-source/blob/master/LICENSE.md) 原文："basically Apache License Version 2.0 plus the 'powered by wisemapping' text requirement on every single page"。每个 UI 界面必须显示 "powered by WiseMapping" 并链接官网，除非获得作者邮件授权。**商用产品集成需注意该署名义务，本质是弱 copyleft 式品牌条款**。
- **结论**：不适合作为"AI 生成脑图"的嵌入组件（太重、Java 全家桶、许可证有额外义务），仅适合自部署完整脑图站。

### 3.9 blink-mind（awehook/blink-mind）

- **定位**：React + immutable.js 的思维导图库（曾配套 blink-mind-desktop）。
- **维护状态（关键）**：最后 commit **2022-02-10**，npm `blink-mind-react` 最后发布 **2019-10**（0.1.8-beta.5）——实质停更。React 17 时代产物。
- **许可证**：MIT。
- **结论**：不推荐新项目采用；仅在需要参考其插件化设计时可看。

### 3.10 kityminder-core（fex-team）

- **定位**：百度脑图（naotu.baidu.com）的核心渲染/编辑库。
- **数据格式**：JSON 脑图协议（`kityminder.data`）；README 明确"不包含第三方格式（FreeMind、XMind、MindManager）的支持，可以加载 kityminder-protocol 来扩展第三方格式支持"。
- **维护状态（关键）**：最后 commit **2018-09**（v1.4.43 release 2017-05），npm 最后发布 **2018-08**（1.4.50）——已死项目，只是仓库在 2024 年前偶有 push。派生生态（DesktopNaotu 5,090 star，GPL-2.0）仍在，但底层不动了。
- **许可证**：BSD-3-Clause（core）；[kityminder-editor](https://github.com/fex-team/kityminder-editor)（3,179 star）为 **GPL-2.0**——组合使用时注意传染性。
- **结论**：情怀选项。中文文档好、功能经典，但 2018 年后无维护，现代打包/TS/安全更新全无，不建议新项目依赖。

### 3.11 补充发现：plait-board/drawnix

- **定位**：开源一体化白板（脑图 + 流程图 + 自由画 + 图片），底层是 [worktile/plait](https://github.com/worktile/plait) 框架（696 star，MIT，`@plait/mind` 提供脑图数据与渲染）。产品化程度高。
- **数据格式**：自有 `.drawnix` JSON；**README 明确"支持 markdown 文本转思维导图（新支持）"**（`@plait-board/markdown-to-drawnix` 包），支持 mermaid 语法转流程图；导出 PNG/JSON（README 特性列表）。导入导出 XMind/OPML 等暂无（issue #443 markdown 文本节点、#297 脑图转 markdown 为 open，未验证完整度）。
- **AI 集成**：无 AI 功能（README 无 AI 章节核实）。
- **流式**：未验证（无官方流式文档/示例）。
- **维护状态**：star 14,935；v0.4.0（2026-04-19）；push 2026-09-08；open issues 30。开发活跃但版本仍处 0.x，API 稳定性风险。
- **许可证**：MIT。
- **结论**：若想要"开箱即用的可编辑脑图 + 白板"产品底座，drawnix 是最有产品完成度的 MIT 选项；但它偏"白板应用"而非"可嵌入渲染库"，二开要接受 Plait 插件架构（Angular/React 混合）的学习成本。

---

## 4. 已有的开源「AI + 脑图」项目/产品调研

按 star 排序（2026-10-11 GitHub API / GitHub Search 核实），挑值得参考的实现：

| 项目 | Star | 许可证 | 做法概要（一手依据） |
|---|---|---|---|
| [kongkongyo/Ai-Markmap](https://github.com/kongkongyo/Ai-Markmap) | 440 | MIT | 纯前端单文件 HTML。用户输入主题/文本 → OpenAI 兼容 API 生成 markdown → `markmap-lib@0.15.3` + `markmap-view@0.15.3` 渲染，支持多版本、右侧即时同步左侧 markdown 编辑、节点右键编辑、PNG/SVG 导出。README 交代其 90% 代码由 AI 编写。**非流式**（等待完整响应后渲染；markdown 编辑区改动触发重新 transform——未验证是否逐字符流式） |
| [xianjianlf2/MindGeniusAI](https://github.com/xianjianlf2/MindGeniusAI) | 283 | **BSL 1.1**（源可用，非 OSI） | 自托管 AI agent（Vercel AI SDK v5 工具循环）：plan → RAG 检索 PDF → draw → edit；前端 `@antv/x6` + `@antv/hierarchy`；`@microsoft/fetch-event-source` 做 SSE；**按节点 id 做外科手术式局部修改**（README 明示"surgical edits — patches exact nodes by id, no full re-render"）。是目前对"AI 会话式编辑脑图"实现最完整的参考 |
| [jinzcdev/markmap-mcp-server](https://github.com/jinzcdev/markmap-mcp-server) | 290 | MIT | 把 markdown 转 markmap 交互图的 MCP server，导出 PNG/JPG/SVG——展示 markmap 在 Node 侧的 headless 用法 |
| [linus-sch/Mind-Map-Wizard](https://github.com/linus-sch/Mind-Map-Wizard) | 359 | **CC BY-NC 4.0（禁商用）** | mindmapwizard.com 的开源版：OpenRouter/Ollama + 精心设计的 markdown 大纲 prompt（`prompt.txt` 要求 `#` 层级、具体事实、2-3 层深度），自研 SVG 渲染器 + AI 编辑助手 + 拖拽排序。**非流式**（`await response.json()` 后整图渲染，源码核实）。许可证限制商用参考 |
| [u14app/mindmap（Open MindMap）](https://github.com/u14app/mindmap) | 21 | Apache-2.0 | **原生支持 AI 流式输出的脑图运行时**（README 定位语），React + TS，`@xiangfa/mindmap`：v0.9 拆分 headless core / static / viewer / editor；`core/streaming.ts` 实现了 `createMarkdownStream`——对追加的 markdown 做 parser.append → diffMindMapDocuments → applyMindMapPatches，**按 requestAnimationFrame 批量提交 patch**（源码核实），并带 reconcileMindMapIds 维持节点 id 稳定。是"流式 markdown→脑图"最完整的开源工程范本，虽然 star 少、成熟度待观察 |
| [Zhaimiaoyizhi/TurnMap](https://github.com/Zhaimiaoyizhi/TurnMap) | 39 | MIT | 浏览器扩展：把 ChatGPT/Gemini/Claude 等 AI 网页对话实时映射为可编辑脑图（每个问答轮次一个节点），支持 OPML/Markdown/SVG/PNG 导出。渲染用 `@xyflow/react@12.8.5`（package.json 核实） |
| [satellitecomponent/Neurite](https://github.com/satellitecomponent/Neurite) | 2,151 | MIT | "Fractal Graph-of-Thought"：面向 AI Agent 的分形思维导图/白板（为 agent 提供网页、笔记、代码的组织画布），偏实验性 agent 前端 |
| [Promptly-Technologies-LLC/mcp-structured-thinking](https://github.com/Promptly-Technologies-LLC/mcp-structured-thinking) | 28 | MIT | MCP server：让 LLM 以"程序化构建脑图"的方式进行结构化思考——反向参考（脑图作为 LLM 的思考介质而非输出介质） |
| [florian-kalisch/auto-mindmapping](https://github.com/florian-kalisch/auto-mindmapping) | 69 | MIT | GPT + mermaid mindmap 的早期参考实现（2024，已不活跃），验证了"LLM 产 mermaid 缩进大纲"路线 |

**商业产品对照**（非开源，仅作形态参考）：Whimsical AI、XMind AI、Miro AI、幕布/TreeMind树图等均为"对话/文本 → 可编辑脑图"的 SaaS；markmap 也是 VSCode 插件（`gera2ld.markmap-vscode`）与 Obsidian 生态（如 obsidian-markmind，126 star）的常用底座。开源世界里"AI 生成 + markmap 渲染"是最常见的组合（Ai-Markmap、markmap-mcp-server、Mind-Map-Wizard prompt 均产 markdown）。

---

## 5. 技术路线对比：LLM 应该生成什么格式 + 用什么渲染

### 路线 A：LLM 输出 Markdown（标题层级 + 嵌套列表），markmap 渲染

- **LLM 侧**：markdown 树是 LLM 最擅长、token 效率高、训练语料极多的结构；prompt 简单（参考 Mind-Map-Wizard 的 prompt.txt）。缺点：语义只有"层级"，无节点 id、无样式/图标等元数据；标题最多 6 级（官方 FAQ）。
- **流式表现（有源码依据）**：`Transformer.transform()` 幂等、可重复调用（transform.ts 源码）；`Markmap.setData()` 用 `state.key`（父 id + 内容 hash）做 D3 keyed join（view.ts 源码），已有节点 DOM 复用 + transition 动画。节流调用即可获得平滑的"脑图生长"效果。**这是所有候选里唯一"官方两步 API 天然支持反复全量刷新 + 动画连贯"的库。**
- **代价**：每次 transform 是全量 markdown→树 重算（毫秒级，可节流）；无编辑能力，适合"展示 + 轻交互"。
- **工程风险**：低。API 面（Transformer + Markmap + options）小而稳定（0.18.x，2025-06 后无破坏性更新）。

### 路线 B：LLM 输出 JSON 树（自定义 schema），simple-mind-map / mind-elixir / X6 渲染

- **LLM 侧**：直接产 JSON 树 token 开销大（括号/引号/转义），结构错误率高于 markdown；但可携带 uid（支持后续按节点 id 局部修改，MindGeniusAI 的做法）。
- **流式表现**：simple-mind-map 官方实践是「流式 markdown→`transformMarkdownTo`→`updateData` 循环渲染」（AiCreate.vue 源码），作者明确"一个个字不推荐，很耗性能"（issue #702）——即全量 set + 全量 re-render，按批次喂可用；节点 uid 复用靠应用层 `addUid()`。mind-elixir `refresh()` 全量，无官方流式方案（未验证）。X6/G6 需要 diff 或全量 setGraph，动画连贯性未验证。
- **代价**：换来了完整编辑器能力（拖拽、右键、主题、导出 XMind/PNG/PDF 等）；付出是二开与维护成本、以及流式渲染要自己做节流 + uid 稳定性。

### 路线 C：LLM 输出 Mermaid mindmap 语法

- **优点**：文本语法比 JSON 对 LLM 更友好；若产品已有 mermaid 渲染管线（文档站、笔记类产品），零新增依赖。
- **流式表现（有依据）**：**不适合**。Jison 语法器 + `mermaid.render()` 全量 parse——不完整语法直接抛错（[官方 API 文档](https://mermaid.js.org/config/usage.html)：invalid 时 throw / `suppressErrors` 返回 false），无部分渲染能力；整图重画无节点复用动画。只能"生成完再渲染"或做"上次成功版本兜底"的伪流式（未验证最佳实践）。且 mindmap 类型官方标注 experimental。
- **适用**：聊天中"一次性出图"的静态展示场景。

### 路线 D：结构化增量协议（自定义 patch 流，如 u14app/mindmap）

- 把 LLM 输出流即时 parser.append → 文档 diff → patch 提交（u14app/mindmap `core/streaming.ts` 源码：rAF 批量 commit + id reconcile）。效果最好（真流式 + 最小更新 + id 稳定），但需要自研/采用尚不成熟的库，工程投入最大。适合把"流式脑图"做成核心卖点的产品。

### 三种 LLM 输出格式的流式对比结论

| 输出格式 | 流式难度 | 视觉效果 | 结构可靠性 | 推荐渲染层 |
|---|---|---|---|---|
| Markdown | 低（节流 + 全量 re-transform 即可） | 好（markmap 有生长动画） | 高（LLM 最熟） | markmap-view |
| JSON 树 | 中（需分批 + uid 复用，或 diff/patch） | 中～好（取决于库的重渲染策略） | 中（需 schema 约束 + 容错解析） | simple-mind-map / X6 / mind-elixir |
| Mermaid | 高（半截语法不可 parse） | 差（整图闪烁） | 中（缩进敏感） | mermaid |

---

## 6. 选型建议：「AI 对话生成脑图」

### 推荐方案（主路线）：LLM 流式输出 Markdown + markmap 渲染

**适用**：对话生成后的主要诉求是"看图 + 折叠/缩放浏览 + 导出分享"，脑图以 AI 输出为主、人工深度编辑为辅。

**架构**：
```
聊天输入 → LLM（stream, prompt 要求 #-层级 markdown 大纲）
        → 前端按 chunk 节流（100~200ms）调用 new Transformer().transform(partial)
        → mm.setData(root)（markmap-view，D3 keyed join + 动画）
        → 完成后可用 toolbar（markmap-toolbar）或自行加导出（SVG/PNG/HTML）
```

**理由（均有第 3/4 节一手依据）**：
1. 流式最顺：transform + setData 的两步 API 天然适配"部分 markdown 反复渲染"，keyed join 保证旧节点动画连贯（源码核实）。
2. AI 生态事实标准：Ai-Markmap、markmap-mcp-server、markmap-vscode 等均选它，踩坑成本低；LLM 产 markdown 的可靠性最高（各家模型最熟的格式）。
3. MIT、框架无关、双包体积小、维护健康（2026-09 仍有 push，月下载 55 万+）。
4. `markmap-autoloader` 支持在聊天消息流里直接嵌 `<div class="markmap"><script type="text/template">markdown</script></div>` 自动渲染（官方文档），非常适合聊天 UI 的消息卡片形态。

**风险与对策**：
- markmap 只读（可折叠、不可编辑节点）：若用户要"改图"，可提供"复制为 markdown / 导出后用 simple-mind-map 等编辑器打开"的逃生通道；或进入编辑态时切换渲染库（markdown→JSON 树转换成本可控，simple-mind-map 官方就有 markdownTo 解析器可参考）。
- markdown 6 级标题上限：prompt 中约束层级 ≤4，深层用嵌套列表。
- 折叠状态在内容变化后可能重置（key 含内容 hash，源码推断未实测）：流式期间禁用折叠交互、完成后启用，可规避。

### 备选方案 1：需要"生成后可编辑"→ simple-mind-map 库（JSON 树 + markdown 转换）

**适用**：产品形态是完整脑图工具（编辑、主题、大纲、XMind 导入导出），AI 只是入口之一。
- 依据：库 MIT、框架无关、功能最全（多布局、导出 png/svg/pdf/json/md/txt 源码核实）；官方 `AiCreate.vue` 给出了完整的「流式 markdown → transformMarkdownTo → updateData 循环 + uid 复用」参考实现（源码核实），照抄思路即可。
- 风险：README 明示库与 Web 进入低维护状态、客户端/部分插件闭源；文档中文为主；API 面大。若接受这些，它是功能/许可/活跃度平衡最好的可编辑库。mind-elixir（MIT、最活跃、API 最小）是轻量替代，但 markdown→树 与流式都要自建。

### 备选方案 2：产品核心是"画布/无限白板 + 脑图"→ React Flow（或 X6/G6）自建

**适用**：要把脑图做成深度可编辑画布（节点富内容、连线、协作）、且团队愿意自建树布局与流式逻辑。
- React Flow + d3-flextree/hierarchy 布局 + 自定义节点，流式时按 diff 调 `setNodes`；TurnMap（MIT）证明可行。X6 路线可直接抄 MindGeniusAI 的「SSE + 按节点 id patch」模式（注意 MindGeniusAI 本体是 BSL 1.1，只可参考思路）。
- 成本最高，自由度最高；长期维护权在自己手里。

### 不推荐用于本场景

- **mermaid mindmap**：不可流式（parse 全量 + experimental），只适合静态一次性出图。
- **kityminder-core**（2018 年停更）、**blink-mind**（2022 年停更）：维护风险不可接受。
- **WiseMapping**：WPL 署名条款 + Java 完整应用，嵌入二开成本高。
- **jsmind**：可用但功能与流式支持最弱，无明显差异化理由。

### 决策速查

| 你的场景 | 推荐 |
|---|---|
| 聊天内对话生成脑图，看完即可（可折叠/导出） | **markmap（markdown 流式）** |
| 生成后要像脑图软件一样编辑、多结构、导出 XMind | simple-mind-map（库）或 mind-elixir |
| 白板级自由画布、协作、节点自定义 | React Flow（React）/ X6（框架无关） |
| 已有 mermaid 渲染管线，只加"一句话出图" | mermaid（接受非流式） |
| 把"流式生长的脑图"当核心卖点、愿意趟新库 | 研究并评估 u14app/mindmap 的 streaming core 设计 |

---

## 7. 参考资料链接

**官方与文档**
- markmap 官网/文档：https://markmap.js.org/ ｜ markmap-lib 文档：https://markmap.js.org/docs/packages--markmap-lib ｜ markmap-view：https://markmap.js.org/docs/packages--markmap-view ｜ autoloader：https://markmap.js.org/docs/packages--markmap-autoloader ｜ FAQ：https://markmap.js.org/docs/faq
- markmap 源码关键文件：transform（https://github.com/markmap/markmap/blob/master/packages/markmap-lib/src/transform.ts）、view（https://github.com/markmap/markmap/blob/master/packages/markmap-view/src/view.ts）
- simple-mind-map：仓库 https://github.com/wanglin2/mind-map ｜ 文档 https://wanglin2.github.io/mind-map-docs/ ｜ 官网 https://sxmind.cn/ ｜ AiCreate 源码 https://github.com/wanglin2/mind-map/blob/main/web/src/pages/Edit/components/AiCreate.vue ｜ issue #702 https://github.com/wanglin2/mind-map/issues/702 ｜ issue #1116 https://github.com/wanglin2/mind-map/issues/1116
- mind-elixir：https://github.com/SSShooter/mind-elixir-core ｜ README（数据结构/Markdown Support/Build with AI 章节）
- jsmind：https://github.com/hizzgdev/jsmind ｜ 数据格式文档 https://github.com/hizzgdev/jsmind/blob/master/docs/en/1.usage.md ｜ 操作文档 https://github.com/hizzgdev/jsmind/blob/master/docs/en/3.operation.md
- mermaid mindmap：https://mermaid.js.org/syntax/mindmap.html ｜ API（parse/render 错误行为）https://mermaid.js.org/config/usage.html ｜ mindmap definition 源码 https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/diagrams/mindmap/mindmap-definition.ts
- React Flow mind map 教程：https://reactflow.dev/learn/tutorials/mind-map-app-with-react-flow ｜ 配套代码 https://github.com/xyflow/react-flow-mindmap-app
- AntV X6 mindmap 示例源码：https://github.com/antvis/X6/blob/master/site/examples/layout/tree/demo/mindmap.ts ｜ G6 Mindmap 布局文档：https://g6.antv.antgroup.com/manual/layout/mindmap-layout（v5，type: 'mindmap'）
- WiseMapping 许可证：https://github.com/wisemapping/wisemapping-open-source/blob/master/LICENSE.md
- kityminder-core：https://github.com/fex-team/kityminder-core ｜ kityminder-editor（GPL-2.0）：https://github.com/fex-team/kityminder-editor
- blink-mind：https://github.com/awehook/blink-mind ｜ drawnix：https://github.com/plait-board/drawnix ｜ plait 框架：https://github.com/worktile/plait

**AI + 脑图参考实现**
- Ai-Markmap：https://github.com/kongkongyo/Ai-Markmap
- MindGeniusAI：https://github.com/xianjianlf2/MindGeniusAI
- markmap-mcp-server：https://github.com/jinzcdev/markmap-mcp-server
- Mind-Map-Wizard：https://github.com/linus-sch/Mind-Map-Wizard（CC BY-NC）
- Open MindMap（流式 core）：https://github.com/u14app/mindmap ｜ streaming 源码 https://github.com/u14app/mindmap/blob/main/src/components/MindMap/core/streaming.ts
- TurnMap：https://github.com/Zhaimiaoyizhi/TurnMap
- auto-mindmapping（mermaid 路线参考）：https://github.com/florian-kalisch/auto-mindmapping
- Neurite：https://github.com/satellitecomponent/Neurite
- mcp-structured-thinking：https://github.com/Promptly-Technologies-LLC/mcp-structured-thinking
- 音频对话实时脑图示例（markmap 前端用法）：https://github.com/i-am-alice/3rd-devs （`audio-map-frontend/src/app.ts`）

**API 数据源（2026-10-11 核实）**
- GitHub REST API：https://api.github.com/repos/{owner}/{repo}（star/pushed_at/license）
- npm registry：https://registry.npmjs.org/{package}（版本/发布时间/license）；npm 下载量 API：https://api.npmjs.org/downloads/point/last-month/{package}
