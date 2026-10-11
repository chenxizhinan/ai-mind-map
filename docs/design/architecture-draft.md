# ai-mind-map 需求与架构草案

> 状态：草案（随需求讨论持续更新）。渲染层选型待「万级节点性能调研」结论后补全，调研报告见 `docs/research/`。
>
> 更新日期：2026-10-11

## 1. 产品定位

用 Claude（通过 MCP 或 skill）读取代码库与方案文档，梳理并生成测试用例脑图；本地脑图应用负责渲染、编辑与评审。AI 对话式生成是后续能力，不是首期范围。

核心链路：

```
Claude 连接 MCP → 读取代码/方案 → 增量构建用例树 → JSON 文件落盘
     → 脑图应用（监听文件）渲染万级节点 → 人工评审/批注
     → Claude 读取批注 → 修订用例 → 回复批注（评审闭环）
```

## 2. 需求清单

| # | 需求 | 约束/说明 |
|---|---|---|
| R1 | 上万节点（10k+）渲染流畅 | 硬性要求，支持折叠浏览全量用例树 |
| R2 | 两类节点：`path`（模块路径）/ `case`（用例叶子） | 父节点只作路径，叶子承载用例 |
| R3 | case 叶子可填写用例信息 | 优先级、前置条件、步骤、预期结果 |
| R4 | AI 经 MCP/skill 增量构建与修订用例树 | 分批、可校验；不依赖对话 UI |
| R5 | 节点级评审与批注 | 批注线程、解决状态、可按批注导航 |
| R6 | （后续）AI 对话式生成 | 依赖 R4 的数据与工具底座 |

## 3. 数据模型

单一 JSON 文件（如 `testcases.mindmap.json`）为唯一数据源，树与批注同文件分节存放，MCP 与应用都读写此文件。

```jsonc
{
  "version": 1,
  "meta": { "title": "订单中心-测试用例", "updatedAt": "..." },
  "tree": {
    "id": "n_0001",
    "type": "path",                    // path | case
    "text": "登录模块",
    "children": [
      {
        "id": "n_0042",
        "type": "case",
        "text": "错误密码连续输错5次锁定账户",
        "priority": "P1",              // P0-P3，对齐 XMind 优先级标记约定
        "precondition": "已注册用户，账户未锁定",
        "steps": ["输入正确用户名", "连续输错密码5次"],
        "expected": "账户锁定30分钟，第6次登录提示已锁定"
      }
    ]
  },
  "annotations": [
    {
      "id": "a_0001",
      "nodeId": "n_0042",
      "createdBy": "txlei",            // 人或 "claude"，为多人协作预留
      "createdAt": "2026-10-11T10:00:00+08:00",
      "body": "边界情况缺了：第4次输错的提示文案是否验证？",
      "status": "open",                // open | resolved
      "replies": [
        { "id": "a_0002", "createdBy": "claude", "createdAt": "...",
          "body": "已补充 n_0043 覆盖该提示。" }
      ]
    }
  ]
}
```

设计要点：

- 批注独立成集合、以 `nodeId` 关联，不挂在树节点内——树数据保持精简（万级节点下序列化与 diff 成本更低），批注增删不触碰树结构。
- `createdBy` 现在就留字段：首期单用户（人 + Claude 两个身份），将来接多人不用改结构。
- `priority` 用 P0-P3 文本，导出 XMind 时映射为优先级标记（Meterosphere/禅道均认此约定，格式细节见调研报告）。

## 4. MCP 工具设计

MCP server 为本地 Node/Python 进程，无 HTTP 服务；工具直接读写上述 JSON 文件（进程内持有副本，写后落盘）。树构建工具每次调用都做结构校验（父节点存在、叶子类型合法、id 冲突检测）。

| 工具 | 作用 |
|---|---|
| `create_tree(root, meta?)` | 建树/重置，返回根 id |
| `add_subtree(parentId, subtree)` | 增量追加子树（批量建用例的主要入口），返回分配的节点 id |
| `update_node(nodeId, fields)` | 改节点文本/类型 |
| `set_case_details(nodeId, {priority, precondition, steps, expected})` | 填用例详情 |
| `delete_subtree(nodeId)` | 删除 |
| `query_tree(nodeId?, filter?)` | 读树（分页/按路径过滤，避免超大响应） |
| `add_annotation(nodeId, body, createdBy)` | 加批注（Claude 自查时也可用，如标注"覆盖不足"） |
| `list_annotations(nodeId?, status?)` | 读批注——Claude 修订前先读人留下的意见 |
| `reply_annotation(annotationId, body)` | 回批注 |
| `resolve_annotation(annotationId, resolved)` | 标记解决 |

skill（给 Claude 的操作手册）与 MCP 配合：约定「先读方案与代码 → 分模块分批 add_subtree → 叶子统一 set_case_details → 提交前 query_tree 自检」的节奏，以及用例命名的团队规范。skill 单独使用（纯写文件）无校验能力，只作为 MCP 不可用时的降级路径。

## 5. 渲染层选型（依据 [large-scale-rendering-and-testcase-tools.md](../research/large-scale-rendering-and-testcase-tools.md)）

**结论：canvas 自研渲染层 + 现成树布局库 + DOM overlay 编辑层。**

万级（10k+）+ 可编辑 + 批注三个约束叠加下，没有现成开源库能直接满足（逐一排除的依据见调研报告第 1 节）：

| 候选 | 万级判定 | 关键依据 |
|---|---|---|
| simple-mind-map | ❌ 否决 | 作者一手证言「1000+ 节点卡顿明显，超大数据量底层得用 canvas」（issue #610），性能模式默认关闭且瓶颈在布局 |
| markmap / mind-elixir / Plait | ❌ 否决 | SVG foreignObject 全量渲染、无视口裁剪，机制性上限 |
| G6 v5 | ❌ 否决 | 2026 年仍有多个未关闭的中等规模性能 issue（300 节点 3s 卡顿、2000 节点渲染不出、官方 60k 示例崩溃） |
| jsmind | ❌ 否决 | 仅连线层是 canvas 且有尺寸上限（数千节点翻车），节点仍全量 DOM |
| X6 | ⚠️ 降级备选 | 唯一带官方虚拟渲染（`virtual: true`）的编辑引擎，可先验证产品形态；但万级未验证、树布局/折叠要自己拼装 |
| GoJS | 📐 仅作参照 | canvas + 视口虚拟化 + 123k 节点示例证明架构可行，但商业闭源（$3,995/开发者起），不采用 |

自研方案（工作量预估 2-4 周，不含完整功能面）：

- **渲染分层**：canvas 主画布（节点框/连线/折叠按钮/批注角标/优先级色条）+ DOM overlay（仅选中节点的内容编辑框、右键菜单）+ 数据层（不可变树 + 视口状态）。只有被编辑/选中的节点才存在于 DOM 中。
- **布局**：`@antv/hierarchy`（mindmap 模式）或 `d3-flextree`，数据变更时计算（非每帧），可放 Web Worker。
- **视口裁剪**：扁平节点数组（按 y 排序）+ 视口矩形求交，只绘制相交节点；10k 节点线性扫描 <0.1ms。折叠使「默认折叠两级」下实际渲染节点常在数百级。
- **编辑**：文本编辑用 DOM（contenteditable 投影定位，IME 隔离），命中测试在扁平数组上矩形求交。

### 5.1 评审批注的渲染细节

- **批注角标**：节点右上角绘制「未解决批注数」徽标（有 Claude 回复的线程用不同颜色），hover 显示批注摘要 tooltip。
- **侧边面板**「批注」页签：线程列表（人/Claude 身份由 `createdBy` 区分）、回复输入框、解决按钮；「解决」后角标变灰。
- **批注导航**：批注列表侧栏点击 → 画布平移缩放至该节点（视口动画）+ 选中高亮 + 打开面板页签。「仅看有未解决批注」过滤时，布局只对过滤后的树计算，折叠状态保留。

## 6. 已知风险与决策记录

| 决策/风险 | 结论 |
|---|---|
| LLM 一次性输出万级用例不可行 | 用 MCP 增量工具分批构建，每批校验（R4 设计依据） |
| MCP 与人工编辑同写一个文件的冲突 | v1：应用监听文件 mtime，检测外部变更后提示刷新；v2 若冲突频繁，将 MCP server 升级为本地常驻服务，应用与 MCP 共享同一内存态 |
| SVG 渲染库在万级节点的性能 | 已定论：全部排除（含作者一手证言与多条 issue 实测），选 canvas 自研，见第 5 节 |
| 首期是否做多人实时协作 | 不做，数据模型已留 `createdBy` 扩展位 |
| XMind 导出对接测试平台 | 作为导出能力后续实现；格式对齐三平台约定：MeterSphere v3（`case-P1` 前缀 + 中文键子主题）、禅道（`[C:, P:]` 特征字符）、TestLink（复用 xmind2testcase 映射） |

## 7. 待补全（等调研/后续讨论）

- ~~渲染层选型结论~~ 已完成（第 5 节）
- AI 对话式生成的交互与流式方案（复用 R4 底座后评估）
