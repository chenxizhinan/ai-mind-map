# 万级节点渲染性能调研 & 测试用例脑图工具盘点

> 调研日期：2026-10-11。本文回答两个问题：① 主流脑图/图库在万级（10k+）节点下的渲染性能证据；② 测试用例脑图领域的现有工具与格式约定。
> 证据等级标注：**[issue 实测]** = 用户在 issue 中给出具体节点数与现象；**[官方说法]** = 官方文档/README/作者回复；**[源码核实]** = 阅读仓库源码确认；**[推断]** = 基于公认前端知识的推理；**[未验证]** = 未找到一手依据。
> Star 数等基础数据沿用同目录《mindmap-library-selection.md》（2026-10-11 已核实），本文不重复。

---

## 1. 万级节点渲染：各库性能证据

### 1.1 汇总表

| 库 | 渲染机制 | 视口裁剪/虚拟化 | 全部展开 vs 折叠 | 万级节点可行性 | 证据等级 |
|---|---|---|---|---|---|
| markmap | SVG（节点文本用 foreignObject） | 无，全量渲染 | 折叠可减 DOM（d3 exit），无官方展开性能说明 | 不可行（无裁剪，万级 foreignObject 会拖垮浏览器） | 机制 [源码核实]；结论 [推断] |
| simple-mind-map (wanglin2/mind-map) | SVG + foreignObject | 有：`openPerformance` 性能模式，只渲染可视区节点（默认关闭） | 作者明示"收起节点"是官方优化手段之一 | **不可行**：作者称 1000+ 即明显卡顿，7k 节点卡顿正常，"超大数据量底层得用 canvas" | [issue 实测] + [官方说法] |
| mind-elixir | SVG（foreignObject 富文本） | 无找到相关实现 | 未找到官方展开性能说明 | 未验证；README 仅宣称"optimized for large mind maps" | 机制 [源码核实]；性能声明 [官方说法]；万级 [未验证] |
| jsmind | **DOM 节点 + canvas/svg 连线**（混合） | 无（节点全量 DOM） | 未找到官方说明 | 不可行：canvas 连线层有尺寸上限，数千节点画布超限（背景变黑、连线消失），官方建议切 svg engine | [issue 实测] + [官方说法] |
| Plait / drawnix | SVG + foreignObject（roughjs 画手绘风连线） | 无找到 | 未找到 | 未验证（无性能 issue，脑图场景定位偏中小规模白板） | 机制 [源码核实]；万级 [未验证] |
| AntV G6 v5 | 默认 Canvas（@antv/g，自带脏矩形），可切 SVG/WebGL | 底层 @antv/g 有脏矩形优化；**无按视口裁剪节点的公开配置** | 布局/动画随全图规模线性变贵 | **风险高**：社区实测 300 节点动画致 3s 卡顿、2000 节点渲染不出、官方 60000 节点示例在 Chrome 147 直接崩溃；v4 同场景 8000+ 节点可秒渲 | [issue 实测]（多条） |
| AntV X6 | SVG DOM | 有：`virtual: true` 虚拟渲染（只渲染可视区 view），可配 scroller | — | 中等可行：虚拟渲染 + async 渲染是官方特性，但万级 SVG DOM 仍属极限场景；2020 年有 600 节点卡顿 issue（后官方优化为整体缩放） | [官方说法] + [issue 实测] |
| GoJS（参照，商业） | HTML5 Canvas | 有：官方 Virtualized**Tree** 示例 123,456 节点"加载渲染相当快" | — | 可行（万级无压力），代价是许可证费 | [官方说法] |
| cytoscape.js（参照） | Canvas（批量绘制） | 无视口虚拟化，但 canvas 绘制量与可见节点相关 | — | 渲染可行，但做成脑图编辑器需自研布局/折叠/编辑，工作量大 | [官方说法/README] + [推断] |
| sigma.js（参照） | WebGL | 天然面向"数千到数百万节点" | — | 渲染层可行，但交互编辑（文本、右键菜单、行内编辑）几乎全部自研 | [官方说法] |

### 1.2 逐库详情

#### 1.2.1 simple-mind-map（wanglin2/mind-map）—— 证据最充分的"反面参照"

作者 wanglin2 在性能问题上有三条一手表态：

- **issue #610**（2024-04，"思维导图节点数据很多时，操作起来很卡"）：用户报告 7000+ 节点卡顿、1600 节点已明显卡。作者回复：
  > "理论上 **1000+ 节点卡顿就开始明显了**，节点都是 svg 渲染的，页面上 DOM 节点多了卡顿是难以避免的。……百度脑图性能是更好一点，但本质上都是 svg……**想要超大数据量，底层还是得用 canvas 来渲染**。"
  https://github.com/wanglin2/mind-map/issues/610
- **issue #1179**（2025-03，"渲染 200 个节点首次创建耗时过久"）：作者的回复是"可以尝试收起节点，和开启性能模式"——即官方承认节点数与卡顿直接相关，折叠和性能模式是官方给出的两条出路。
  https://github.com/wanglin2/mind-map/issues/1179
- **issue #1384**（2026-09）：作者称"**其实主要瓶颈在布局算法**"（回复移动端性能探讨）。
  https://github.com/wanglin2/mind-map/issues/1384

**视口裁剪能力（有源码依据）**：v0.10.4 起（2024-07）提供 `openPerformance` 配置——**默认关闭**；开启后只渲染画布可视区域内（四周 padding 100px）的节点，节点移出视区从画布删除；代价官方文档明列为：拖动/缩放时实时计算渲染新节点会带来卡顿；导出图片/SVG/PDF 需先强制渲染全部节点所以变慢。实现见源码 `MindMapNode.render()`（`checkIsInClient(padding)` 判断）与 `Render.js`（`forceLoadNode` 等）：
- 官方文档：https://wanglin2.github.io/mind-map-docs/#/api/constructorOptions （docsite 源码 https://github.com/wanglin2/mind-map-docs/blob/main/src/api/constructor/constructor-options.md 第 114-115 行）
- 源码：https://github.com/wanglin2/mind-map/blob/main/simple-mind-map/src/core/render/node/MindMapNode.js （L601-618）、`.../Render.js`（性能模式节流重渲，250ms 节流）

其他相关 issue：#667（1000 节点收起状态创建节点也卡，定位为 defenseXSS 太慢，v0.9.13 修复）、#721（1000 节点展开/收起/激活均卡，催生 v0.10.4 性能优化）、#1323（非富文本模式 measureText 大量 DOM retry，**1000 节点渲染需 10 秒**，社区给出了修复建议）、#385（**100 节点**下批量添加子节点就明显卡）、#1073（作者提交的优化：减少布局循环、仅处理变动节点、连线只画可视区域）。
链接：https://github.com/wanglin2/mind-map/issues/667 /721/1323/385/1073

**结论**：simple-mind-map 是"SVG 全量渲染 + 可选视口裁剪"的代表。万级节点即便开性能模式，布局计算和交互仍会卡（作者自己说瓶颈在布局）；它适合 ≤1000 节点，对 10k 目标是明确的否决项——且作者本人指出的出路（canvas 底层）恰好佐证了自研 canvas 方向的合理性。

#### 1.2.2 markmap

- 渲染机制 [源码核实]：`markmap-view` 用 d3 操作 SVG，节点文本是 `<foreignObject>` 内嵌 HTML；`setData` 走 keyed data join（`d.data(nodes, d => d.state.key)`），旧节点 DOM 复用 + transition 动画。源码：https://github.com/markmap/markmap/blob/master/packages/markmap-view/src/view.ts（L373 起、L445 append foreignObject）
- 视口裁剪：**无**。全仓 view.ts（779 行）中不存在任何按可视区增删节点的逻辑（grep visible/cull/virtual 仅命中 ensureVisible 等"把节点滚进视区"的 API）。
- issue 检索：仓库 issues 中无任何"large/slow/10000/性能"相关的性能实测报告（仅 #342 渲染方向建议、#331 布局高度 bug 等）。这既可解读为"没人拿它加载大数据"（它定位是渲染 Markdown 大纲，不是重型编辑器），也说明社区没有万级使用的先例。
- **结论 [推断]**：markmap 渲染 10k+ foreignObject 节点在浏览器中不可行（每个节点一个 foreignObject + 一个 path 连线，DOM 数量 2 万起，滚动/缩放必然重排）。但它没有编辑态负担、d3 join 复用 DOM，在"默认折叠 + 分层展开"场景下撑几千节点问题不大。万级可行性：**不可行，未验证实测**。

#### 1.2.3 mind-elixir

- 渲染机制 [源码核实]：SVG（`createLinkSvg`/`lines: SVGElement`），节点用 HTML/foreignObject 风格富文本。源码：https://github.com/SSShooter/mind-elixir-core/blob/master/src/index.ts
- 官方 README 性能声明 [官方说法]："**High performance - Optimized for large mind maps**"（README Performance & Architecture 节），但无具体数字、无 benchmark。
- issue 检索：无任何性能/大数据量 issue；无视口裁剪相关代码（[源码核实]）。
- **结论**：万级可行性**未验证**。声明与实现之间没有中间证据；按 SVG 全量渲染机制推断，与 markmap 同样存在 foreignObject 规模上限问题。

#### 1.2.4 jsmind —— "canvas 渲染"的真实形态

用户提示"注意它是 canvas 渲染"，需要澄清 [源码核实]：jsmind 是**混合渲染**——节点本体是 DOM 元素（div，`_default_node_render` 往 element 里写 HTML/文本，见 `src/jsmind.view_provider.js` L605-612），**只有节点间连线**画在 canvas 或 svg 上（`view.engine: 'canvas'|'svg'`，默认 canvas）。所以节点一多它同样受 DOM 数量拖累，并没有获得 canvas 的性能红利。

- 关键 issue #242（"当节点特别多的时候，背景会变成黑色，连接线也会消失"，2020 提出至今仍有人复现）：数千节点时 jsmind 默认 canvas 连线层出问题，原因是浏览器 canvas 尺寸上限。官方作者 2024-04 回复：
  > "你在 option 里把 view.engine 设置成 svg …… 浏览器还不能支持无限大的 canvas"
  用户确认切 svg 后"当思维导图的节点很多，面积巨大的时候，使用该模式能带来显著的性能提升"。
  https://github.com/hizzgdev/jsmind/issues/242
- 官方文档 [官方说法]：`view.engine` — "svg：使用 svg 绘制线条，当思维导图的节点很多，面积巨大的时候，使用该模式能带来显著的性能提升"。https://hizzgdev.github.io/jsmind/docs/zh/2.options.html （doc 源码 https://github.com/hizzgdev/jsmind/blob/master/docs/zh/2.options.md L125-131）
- 视口裁剪：无 [源码核实]（`expand_size` 直接把画布扩到全图尺寸）。
- **结论**：jsmind 的"canvas"只是连线层，万级节点不可行；连数千节点的连线层都会踩 canvas 上限。它对本次调研的价值在于提供了一个真实教训：**连线画 canvas、节点留 DOM 的折中方案也会在数千节点量级翻车**。

#### 1.2.5 Plait 与 drawnix

- 渲染机制 [源码核实]：Plait 底层走 SVG（`packages/core/src/utils/dom/foreign.ts` 用 `createElementNS` + foreignObject），手绘风效果用 roughjs 生成 path。drawnix 是基于 Plait 的白板应用，脑图是其中一个插件。源码：https://github.com/worktile/plait/blob/develop/packages/core/src/utils/dom/foreign.ts
- issue 检索：`worktile/plait` 与 `plait-board/drawnix` 中搜"性能/卡/large/performance"均无结果——**没有公开的万级使用证据，也没有官方性能声明**。
- **结论**：机制上属于 SVG DOM 阵营（与 markmap/simple-mind-map 同类），万级可行性**未验证**，按机制推断不乐观。Plait 的架构价值（Slate 式插件化框架）大于性能价值。

#### 1.2.6 AntV G6 v5

- 渲染机制 [官方说法]：默认 Canvas 渲染器（@antv/g），可切换 SVG / WebGL（`renderer` 配置，可分层混用）。文档：https://g6.antv.antgroup.com/manual/further-reading/renderer （doc 源码 https://github.com/antvis/G6/blob/v5/packages/site/docs/manual/further-reading/renderer.zh.md）
- 底层渲染优化 [官方说法]：@antv/g 的 Canvas 渲染器默认开启**脏矩形**渲染（`enableDirtyRectangleRendering`，"开启后将大幅提升 Canvas2D 环境下的渲染性能"），且有加速结构做区域求交。文档：https://github.com/antvis/G/blob/master/site/docs/api/renderer/canvas.zh.md
- 内置 mindmap 树布局 [官方说法]：`layout: { type: 'mindmap', ... }`，含 collapse/expand 交互（behaviors）。文档：https://g6.antv.antgroup.com/manual/layout/mindmap
- **但社区对 v5 性能评价普遍负面，全部为带数字的 issue 实测**：
  - **#7669**（2026-07，open）："动画开销增加快于预期，在中小规模的图（**300 个节点**）中就会导致 **3 秒卡顿**"，profiler 定位到 @antv/g 的 Animation.updatePromises 占 58%。https://github.com/antvis/G6/issues/7669
  - **#7664**（2026-06，open）："超过**几百个节点**，graph.draw 会出现明显卡顿……大数据量绘制卡死前端，期待官方早日出解决方案"。https://github.com/antvis/G6/issues/7664
  - **#7574**（open）："5.0 渲染大数据量明显弱于 4.0，**超过两三千就直接渲染不出来**……资金流向图 demo 加到 1000 需要几十秒；同场景 v4 能秒渲 8000"。https://github.com/antvis/G6/issues/7574
  - **#7402**（open）：同样 500 节点 + 500 边，v5 静置时仍持续计算、拖拽占满多核并内存泄漏，v4 无此现象。https://github.com/antvis/G6/issues/7402
  - **#7648**（2026-04，open）：官方"大数据量"示例（5000/20000/60000 三档）在 Chrome 147 下 60000 档直接 **Maximum call stack size exceeded 崩溃**。https://github.com/antvis/G6/issues/7648 ；示例源码 https://github.com/antvis/G6/tree/v5/packages/site/examples/performance/massive-data
- **结论**：G6 v5 虽是 canvas + mindmap 布局 + 折叠交互"开箱即得"，但 2026 年仍有多个未关闭的中等规模（数百~数千节点）性能回归 issue，v4→v5 性能是公认倒退方向。拿它承载"万级 + 流畅编辑"风险很高（**issue 实测**级证据）。

#### 1.2.7 AntV X6

- 渲染机制 [官方说法/源码核实]：SVG DOM（每个节点一个 SVG `<g>` + foreignObject HTML），编辑能力（锚点、连线、框选、对齐）是六个开源库里最强的。
- 视口裁剪：**有官方虚拟渲染**。Graph 配置 `virtual: true`（`VirtualOptions { enabled, margin }`），配合 scroller 只渲染可视区；2025-09 的 PR #4815 补齐了"滚动场景下的虚拟渲染"，2025-10 PR #4827 优化了批量拖放大量节点的流畅度。源码：https://github.com/antvis/X6/blob/master/src/graph/virtual-render.ts （`VirtualRenderManager`，translate/scale/scroll 时 200ms 节流重设渲染区）；options 定义 https://github.com/antvis/X6/blob/master/src/graph/options.ts （L38-41, L71, L519）
- 性能 issue：#89（2020，600+ 节点缩放冻结，官方回复"每个 node/edge 在 zoom 时都会重渲染，正在改为只缩放顶层 g"）后经多年优化；目前无新的万级实测 issue，但也**没有官方万级 benchmark**。
  https://github.com/antvis/X6/issues/89
- **结论**：X6 是"SVG 阵营里唯一有官方虚拟渲染开关"的库，数千节点配合 `virtual + async` 大概率可用（[推断]）；万级仍属未验证，且 SVG foreignObject 的文本编辑体验在大量节点下成本高。它更像"图编辑引擎"而非脑图——树布局（@antv/hierarchy mindmap）、折叠、父子连线都要自己拼装（上一份选型报告已述）。

#### 1.2.8 参照物

- **GoJS**（商业，[官方说法]）：Canvas 渲染。官方性能文档明确分级："几百节点轻松；**数千到数万节点需要调优**（虚拟化）"；官方 Virtualized Tree 示例 **123,456 节点**"加载和渲染相当快"，因为"只构建与视口相交的节点和连线"。文档：https://gojs.net/latest/intro/performance.html 。许可证模式：按开发者数量买断（perpetual，无运行时费用），个人 **$3,995**、团队（≤3 人）$6,990、Group（≤20 人）$11,950（来源 https://nwoods.com/sales/index.html ，2026-10 查询）。**结论**：GoJS 证明了"canvas + 视口虚拟化 + LOD"是万级脑图的可行解，但闭源商业，不适合本项目直接采用。
- **cytoscape.js**（[官方说法]：canvas 批量渲染，图可视化定位）：渲染数万节点是它的常规场景，但没有脑图语义——树布局（ breadthfirst）、折叠展开（`compound` 节点）、行内文本编辑、XMind 式连线样式都要自己搭，等于"用通用图库造脑图编辑器"，工作量大且交互手感难对齐专业脑图。
- **sigma.js**（[官方说法]：WebGL，目标"thousands to millions of nodes/edges"）：渲染吞吐最强，但它是纯渲染器（无编辑、无布局内建到这种程度），做编辑器同样要自研整套交互层，且 WebGL 下 DOM overlay 文本编辑需要额外的坐标投影层。
- **是否存在遗漏的"canvas 渲染 + 开源"脑图库**（检索 GitHub API：`mindmap canvas`、`脑图 canvas`、`topic:mindmap canvas`、`mind map editor language:typescript`）：**没有**发现 star 过百、以 canvas 为主渲染层且专注脑图的开源库。最接近的只有：jsmind（canvas 仅连线层，见上）、百度脑图（kityminder，闭源在线服务 + 已停更的 kityminder-core，SVG）、若干 Obsidian canvas 插件（Quorafind/Obsidian-Canvas-MindMap 375★、mobench/mindvas 41★，宿主是 Obsidian 的 canvas，非独立库）、frappe/draw（21★，实验性）、winlp4ever/canvas-harness（14★，通用节点图）。**"万级脑图编辑器"这个组合在开源界是空位**——这正是本项目的差异化空间。

---

## 2. canvas 自研渲染层的技术要点

（本节为公认前端知识，无外部依据，按 [公认知识] 处理。）

针对"测试用例脑图 10k+ 节点、叶子节点要点开编辑"的目标，业界成熟路线是 **canvas 主画布 + DOM overlay 编辑层**（Figma/tldraw/百度脑图同构思路）：

### 2.1 渲染分层

```
┌─ DOM overlay 层（绝对定位，随视口变换）
│    - 当前选中节点的文本编辑框（contenteditable/textarea）
│    - 右键菜单、优先级选择器、tooltip、详情抽屉触发区
├─ Canvas 层（1~2 个）
│    - 节点框、连线、折叠按钮、优先级角标
│    - 可选第二层：hover 高亮 / 框选 marquee（避免整层重绘）
└─ 数据层：不可变树 + 视口状态 {scaleX, scaleY, offsetX, offsetY}
```

关键点：**只有被选中的节点才存在于 DOM 中**。开始编辑时把该节点的世界坐标经 `screen = world * scale + offset` 投影成 overlay 的绝对定位，`transform: scale()` 保持字号一致；编辑结束写回数据并重绘 canvas。

### 2.2 视口裁剪（culling）

- 布局阶段为每个可见节点预计算 `{x, y, w, h}`，存扁平数组（按 y 排序即可做脑图的行扫描）。
- 每帧把视口矩形（世界坐标，含 margin ~100px）与节点包围盒求交，只绘制相交者。10k 节点线性扫描也只要 <0.1ms，无需 R-tree；若追求 100k+ 再上四叉树/网格分桶。
- 平移/缩放时**不重建布局**，只重算裁剪窗口；`requestAnimationFrame` 合并输入事件（pointermove 节流至每帧一次）。
- HiDPI：canvas 物理尺寸 = CSS 尺寸 × devicePixelRatio，`ctx.setTransform(dpr*scale, 0, 0, dpr*scale, dpr*offsetX, dpr*offsetY)` 一次搞定缩放与坐标。

### 2.3 折叠（collapse）与布局

- 折叠是脑图相对通用图渲染的最大优势：**折叠后可见节点数是 O(可见深度 × 屏幕高度)**，万级数据在"默认折叠两级"下实际渲染往往只有几百节点。
- 数据结构上用 `expanded: Set<nodeId>` 而非改树；布局计算（Tidy tree / @antv/hierarchy / d3-hierarchy）只对"可见子树"递归，折叠子树贡献一个占位高度。
- 全部展开的降级策略：展开大子树（如 >500 子孙）时给 loading 态，或限制单次展开批量（分帧增量渲染）；与 markmap/simple-mind-map 不同，canvas 每帧重绘使"逐步出现"的动画成本极低。
- 折叠按钮本身就是命中测试对象：`isPointInPath` 或简单的矩形求交即可，无需 DOM 事件。

### 2.4 编辑交互的 DOM overlay 细节

- 文本编辑必须用 DOM（canvas 原生 input 体验差且无法复制粘贴/输入法稳定）。单节点编辑框的生命周期：`dblclick/Enter → 计算 screen 坐标 → mount overlay → blur/Escape → 写回 → unmount`。
- 命中测试：`canvas.getBoundingClientRect()` + 逆变换回世界坐标，在扁平节点数组上二分/扫描；连线不需要命中（脑图不编辑连线）。
- 滚轮缩放锚定鼠标位置：`offset = mouse - (mouse - offset) * (newScale/oldScale)`。
- 输入法（IME）composition 期间不要重渲染整树——编辑态文本只在 overlay 里，天然隔离。

### 2.5 与布局库的配合

布局（树形 tidy 布局）不必自研：`@antv/hierarchy`（mindmap 模式，G6 同款）、`d3-flextree`、`d3-hierarchy` 都可直接输出 x/y。布局跑在数据变更时（非每帧），万级节点 tidy 布局耗时在几十 ms 量级，可放 Web Worker，主线程只收结果数组。

---

## 3. 测试用例脑图：现有工具与格式约定

### 3.1 用例转换工具（XMind → 测试平台）

| 工具 | Star | 活跃度 | 导出格式 | 优先级约定 |
|---|---|---|---|---|
| [zhuifengshen/xmind2testcase](https://github.com/zhuifengshen/xmind2testcase) | 817 | 最后 push 2024-08，30 open issues，仍被大量引用 | TestLink XML、禅道 CSV、JSON（TestSuites/TestCases 两级） | **XMind priority 标记（priority-1/2/3）→ importance 1-3 → 禅道"高/中/低"** |
| [tobyqin/xmind2testlink](https://github.com/tobyqin/xmind2testlink) | 117 | 停更（2020-05） | TestLink XML | priority 标记 → TestLink importance；star 标记启用 v2 规则；flag-green → 执行类型 |

**xmind2testcase 的模板约定（事实上的社区标准，来源：项目官方使用指南 https://github.com/zhuifengshen/xmind2testcase/blob/master/webtool/static/guide/index.md ，一手文档）**：

1. 根主题 = 产品/测试套件（TestSuite），往下是模块层级（模块路径 = 根到用例父节点的链）；
2. **用例节点 = 带 priority 标记的节点**（或无子节点的叶子），"我们使用标注**优先级图标**作为'测试标题'与'测试步骤'界线"——即优先级标记同时充当"这是用例"的判定依据；
3. 用例节点的子主题 = 测试步骤，步骤的子主题 = 预期结果；支持"只有标题没有步骤"；
4. 禅道导入时模块需事先建好（CSV 里是模块路径 + 模块 ID）；TestLink 侧 Notes→suite details、Comments→preconditions、priority 标记→importance。
源码佐证：`parser.py` 的 `get_priority()` 解析 `markers` 中 `priority-N`；`zentao.py` 的映射 `{1:'高',2:'中',3:'低'}`。
https://github.com/zhuifengshen/xmind2testcase/blob/master/xmind2testcase/parser.py 、.../zentao.py

### 3.2 测试平台的 XMind 导入约定（官方一手文档/源码）

**MeterSphere**（13.5k star，文档与源码均为一手）：

- v2.x（基于 kityminder 的脑图视图，官方用户手册）：
  > "脑图**父主题为模块名称，子主题为模块下测试用例，孙主题为测试用例步骤详情或备注信息**。各级主题使用标签方式区分文本内容，支持使用标签方式标记用例优先级。"
  https://github.com/metersphere/docs/blob/v2.x/docs/user_manual/test_track/test_case/test_case.md （§4 基于脑图视图新建用例）
  其前端依赖 `@7polo/kityminder-core`（frontend/package.json [源码核实]）——即 MeterSphere 的用例脑图编辑器本身用的也是已停更的 kityminder。
- v3.x（XMind 导入解析器，源码一手）：
  - 模块路径：非用例节点的父子链拼成 `/` 分隔的模块路径（`nodePath`）；
  - 用例节点判定：标题以 `case` 开头（正则 `((?i)case)`），**优先级写在用例标题前缀里：`case-P0` / `case-P1` / `case-P2` / `case-P3`**（`parseCasePriority()`，合法集合 `Set.of("P0","P1","P2","P3")`）；
  - 步骤组织：用例节点的子主题用**中文键前缀**区分——`前置条件：`、`步骤描述：`（其下每个 `步骤：` 子主题为一个步骤，步骤的 `预期结果：` 子主题为该步预期）、`文本描述：`+`预期结果：`（文本型用例）、`备注：`、`标签：`、`id：`（i18n 源码 case_zh_CN.properties）。
  源码：https://github.com/metersphere/metersphere/blob/v3.x/backend/services/case-management/src/main/java/io/metersphere/functional/xmind/parser/XMindCaseParser.java ；导出侧同构（XmindExportUtil.java，用例节点标题 `"case：" + name`，字段子主题 `"前置条件：..."`）。
- v3.x 内置"AI 生成用例"（列表模式，非脑图模式）：配置模型 → 对话生成 → 勾选 → 同步到模块。官方手册：https://github.com/metersphere/docs/blob/v3.x/docs/user_manual/test_case/test_case.md §7。

**禅道（ZenTao）**（easysoft/zentaopms，源码一手）：新版本支持 XMind 双向流通，采用**可配置的"特征字符"（type key）方案**——节点标题末尾的 `[...]` 段解析为 KV 对：模块 `M`、场景 `S`、用例 `C`、步骤分组 `G`、前置条件 `pre`、优先级 `P`（均可自定义字符，如 `[C:1, P:2]` 表示 1 号用例优先级 2），解析实现见 `module/testcase/js/showxmindimport.ui.js`（`splitText`/`kv2Obj`/`typeKeys`）与 `module/testcase/lang/zh-cn.php`（"导入特征字符设置：特征字符设置后，Xmind 主题可与禅道测试用例结构相对应"）。优先级默认值 3，取值 1-4。
https://github.com/easysoft/zentaopms/blob/master/module/testcase/js/showxmindimport.ui.js

### 3.3 现成的「测试用例脑图编辑器 / AI 生成用例脑图」项目

| 项目 | 形态 | 说明 |
|---|---|---|
| [didi/AgileTC](https://github.com/didi/AgileTC)（726 star） | 完整平台 | 滴滴开源的脑图用例管理平台（kityminder 系），多人协同；2024-09 后停更。衍生 [SakuraTechy/sakura-agiletc](https://github.com/SakuraTechy/sakura-agiletc)、[Pactortester/react-agiletc-minder-editor](https://github.com/Pactortester/react-agiletc-minder-editor)（9 star） |
| [chenhengjie123/vue-testcase-minder-editor](https://github.com/chenhengjie123/vue-testcase-minder-editor)（102 star） | Vue 组件 | 基于百度脑图（kityminder）的用例编辑器组件，支持记录测试结果；2022 停更 |
| [liangalien/kityminder-case-vue](https://github.com/liangalien/kityminder-case-vue)（3 star） | Vue 组件 | kityminder 用例定制 |
| [ZoeyMind/zoeymind-desktop](https://github.com/zoeymind/zoeymind-desktop)（1 star，2026-09 新项目） | 桌面应用（Electron） | **与本项目定位最接近的先例**：面向测试人员的功能测试用例 AI 编辑器，思维导图 × AI Agent（BYOK），模块/用例/前置/步骤/预期结果为一等节点，P0-P3 优先级，XMind × MeterSphere 双向流通，MCP 支持；自述"大文档高性能模式，2000+ 节点仍顺滑"（其渲染层实现未查证，README 口径） |
| [myersguo/mindmap-generator](https://github.com/myersguo/mindmap-generator) | Web 工具 | LLM 按 PRD 生成测试用例脑图（火山方舟 API），交互式脑图界面 |
| [202room/ai-testcase-generator](https://github.com/202room/ai-testcase-generator) | AI 工作流框架 | 规则驱动的 PRD → XMind → Excel 用例生成框架（面向 Claude 等 AI 编排） |
| [kakawaa/kata](https://github.com/kakawaa/kata) | Claude Code Skills | PRD→用例的 QA 工作流 skill 集（含脑图环节） |
| [Tianwen2000/testpoint-testcases_generate_skill](https://github.com/Tianwen2000/testpoint-testcases_generate_skill) | AI Skill | 需求 → 测试点/测试分析 + XMind 导图 + 可追溯用例 |
| [verygoodwu/game-prd-xmind-tests](https://github.com/verygoodwu/game-prd-xmind-tests) | Codex Skill | 游戏 PRD → 测试用例 + 原生 XMind 脑图 |
| [jlp111/xmind-to-zentao-csv](https://github.com/jlp111/xmind-to-zentao-csv) | 转换脚本 | XMind 用例脑图 → 禅道 CSV，支持 marker 优先级识别 |
| [mcgrapeng/casemap](https://github.com/mcgrapeng/casemap) | 平台 | 从 API 列表自动生成用例脑图、覆盖情况可视化（2026-10 仍活跃，无 star） |

**要点**：AI 生成用例脑图的方向 2026 年明显升温（上面 6 个零 star 小项目全部创建于近 12 个月内），但没有一个同时做到"AI 原生 + 万级流畅渲染 + 步骤级编辑 + XMind 互通"。成熟脑图用例编辑器（AgileTC 系、kityminder 系）全部基于 SVG 系 kityminder，性能上限即上一节讨论的上限；ZoeyMind 是唯一声称做了大文档性能模式的，但体量太小，不构成可直接复用的开源渲染层。

### 3.4 国内 QA 团队用 XMind 写用例的结构约定（多来源交叉）

综合 xmind2testcase 官方指南（工具文档）、MeterSphere v2/v3 官方手册与解析器源码（平台源码）、禅道特征字符设计（平台源码），国内主流约定高度一致：

```
产品/需求（根）
└─ 模块A                    ← 模块路径 = 链条上的各级主题
   └─ 模块A/子模块A1
      └─ [用例] 登录成功-正确账号密码   ← 用例节点：带优先级标记/前缀
         ├─ (priority-P1 标记)      ← 优先级：XMind 原生标记 或 case-P1 文本前缀
         ├─ 前置条件：已注册用户
         ├─ 步骤1：输入正确账号密码  ← 步骤子主题
         │   └─ 预期：登录成功跳首页
         └─ 步骤2：...
```

- **模块路径**：父节点链即模块路径（MeterSphere 拼成 `/模块A/子模块A1`，禅道导入时映射到已有模块树，xmind2testcase 生成 `case_module` 列）。
- **用例 = 叶子**：判据要么是"带 priority 标记"（xmind2testcase / xmind2testlink），要么是文本前缀 `case`/`C`（MeterSphere / 禅道）。
- **优先级**：两种载体——① XMind 原生 priority 标记（`priority-1/2/3`，映射 高/中/低 或 importance）；② 标题文本前缀（`case-P0`，MeterSphere v3；`[P:n]`，禅道）。P0-P3 是 MeterSphere v3 的合法集，社区最常用。
- **步骤/预期**：用例子主题为步骤、孙主题为预期结果（xmind2testcase、MeterSphere、xmind2testlink 三家一致）；MeterSphere 另支持"文本型用例"（`文本描述：` + `预期结果：`）与步骤型并列。

---

## 4. 渲染层选型的初步建议

**结论：万级 + 可编辑 + AI 流式生成三个约束叠加下，没有现成开源库能直接满足；建议 canvas 自研渲染层（布局复用现成库），或以 X6 虚拟渲染做降级方案。**

1. **首选：canvas 自研渲染层**（第 2 节要点），布局用 `@antv/hierarchy`（mindmap 模式）或 `d3-flextree`，编辑用 DOM overlay。依据：
   - 作者一手证言（simple-mind-map 作者："想要超大数据量，底层还是得用 canvas 来渲染"，[issue 实测] #610）；
   - GoJS 官方 123k 节点 VirtualizedTree 证明该架构上限足够（[官方说法]）；
   - GitHub 检索确认该组合无现成开源脑图库（第 1.2.8 节），自研即差异化；
   - 脑图折叠特性使"默认折叠"下可见节点常在数百级，canvas 只需处理"展开大子树"的峰值，实现风险可控。
   - 需自建的部分：折叠树布局缓存、命中测试、DOM overlay 编辑、（可选）协同时的数据层。工作量预计 2-4 周（不含完整脑图功能面）。
2. **降级方案：AntV X6 + `virtual: true` + `async`**。若团队想先验证产品形态、不投入渲染层研发，X6 是唯一自带视口虚拟渲染的编辑引擎（[源码核实] VirtualRenderManager + PR #4815）。代价：仍受 SVG DOM 规模拖累（万级全展开未验证）、树布局/折叠/XMind 风格连线要自己拼、bundle 大。
3. **明确排除**：simple-mind-map（作者明确 1000+ 卡，万级否决）、markmap/mind-elixir/Plait（SVG 无裁剪，机制性上限）、G6 v5（数百节点即有未修复的性能 issue，且 mindmap 编辑能力弱）、jsmind（连线 canvas 有尺寸上限，节点仍 DOM）。
4. **GoJS 只作为性能架构参照**，不采用（商业许可 $3,995/开发者起，闭源）。
5. **数据格式建议**：内部模型对齐第 3.4 节约定（模块路径 + 叶子用例 + P0-P3 + 步骤/预期），导出直接覆盖三端：禅道 CSV（高/中/低）、MeterSphere XMind（`case-P1` + 中文键子主题）、TestLink XML（复用 xmind2testcase 的映射表），可最大化与既有 QA 流程的互通。
