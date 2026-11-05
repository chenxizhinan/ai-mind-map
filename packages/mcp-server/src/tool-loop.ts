/**
 * Claude 工具循环：把 MCP 工具面暴露给 Claude，跑多轮 agentic 循环。
 *
 * 复用 registerTools 的处理函数（stub server 收集器，与 tools.test.ts 同模式），
 * 因此工具行为、校验、落盘与 stdio MCP server 完全一致。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DocStore } from '@ai-mind-map/core';
import { priorityRubricText } from '@ai-mind-map/core';
import { registerTools } from './tools.js';
import type { DocContext } from './doc-manager.js';

export type ToolExecutor = (args: Record<string, unknown>) => Promise<{
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
}>;

/** 把 registerTools 的 MCP 注册面变成可直接调用的工具执行器 */
export function collectToolExecutors(docs: DocContext): Map<string, ToolExecutor> {
  const tools = new Map<string, ToolExecutor>();
  const stubServer = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolExecutor) => {
      tools.set(name, handler);
    },
  };
  registerTools(stubServer as never, { docs });
  return tools;
}

const SYSTEM_PROMPT = [
  '你是测试用例脑图的 AI 助手，可以直接用工具读写脑图文档。',
  '',
  '工作方式：',
  '0. 会话开始先调用 get_skill 获取 test-case-designer 技能的最新版本与规范（平台可能已更新，禁止凭记忆使用旧规范）；',
  '1. 会话开始先 list_documents 了解现有文档；用户要求生成新的用例集/新脑图时务必 create_document 新建文档（会出现在应用首页），严禁往现有文档里灌或覆盖；',
  '   用户要求更新某篇既有文档时，先 open_document（title 或 id）定位，并保存返回的 id。',
  '1b. 用户只会用名称或简称指代文档（如「编辑 hades 用例」「更新 BYOS 那篇」），绝不会知道文件 id：',
  '    不要向用户索要 id；自己先 list_documents 或 open_document 用 title 解析（支持空格分隔的多关键词模糊匹配，顺序无关、大小写不敏感）。',
  '    多篇命中时把报错里的候选（id + 标题 + 更新时间）转述给用户让其选择，确定后始终用同一个 docId。',
  '1a. 所有读取、写入、校验目标文档内容的工具都必须显式传 docId；不要依赖 active 状态。即使期间调用其他文档，也始终使用最初确认的 docId，避免并发 Agent 串文件。',
  '2. 生成用例前先 query_tree（docId + limit 30）了解目标文档的现有结构，避免重复、对齐既有模块命名。',
  '2b. 新建用例集时，按 test-readiness-standard 创建「00 测试准备」区（测试输入、测试范围、测试环境准备、测试数据准备，置于功能分支之前）；更新既有文档时若缺失主动补建，整理脑图时同步维护这些测试资料（范围内的模块与一级分支对应）。',
  '3. 批量建用例用 add_subtree 一次提交一棵完整子树（模块 folder 下挂 case 数组）。',
  '4. 目标文档的根节点 id 见 create_document/open_document 返回的 rootId（新文档为 n_0001）；模块建完后用返回的 nodeId 继续挂用例，每次同时传同一个 docId。',
  '5. 修改完成后用 1-3 句话总结，不要输出大段 JSON。',
  '6. 先从事实来源提取测试条件、风险和判定依据；按执行入口、稳定业务能力或关键状态组织 folder，叶子用 case。',
  '6e. 若本次变更涉及测试平台已有功能，先用 test-platform MCP 只读查询历史用例（search_version_test_cases / get_version_test_case），',
  '    识别历史测试面：历史验证过的行为是否被破坏（回归点）、历史异常/边界用例是否预示同类风险、历史覆盖缺哪些测试面；',
  '    平台旧用例不直接修改——发现问题写进脑图（回归测试点/新用例，remark 引用平台用例 ID 作来源），平台用例维护由用例负责人处理。',
  '6f. 影响面清单是分析需求和技术方案时的思考清单，不是每个需求都会涉及全部测试面：',
  '    先读需求与技术方案，按最终实现方案判断每个测试面是否被触发；被触发的面评估是否补充测试用例/检查表，',
  '    不涉及的面不需要写用例。判断依据是实现方式，不是需求文本是否提及。',
  '    数据一致性（写操作/多表/外部存储→核对页面+接口+数据库+外部副作用）；幂等/重复提交（POST/PUT/任务类）；',
  '    并发/竞态（多人操作同一资源）；权限边界（角色/租户隔离→越权验证）；兼容性（协议/客户端版本/数据迁移）；',
  '    性能基线（批量/大文件/高频→容量边界）；可观测性（新逻辑/新错误路径→日志/审计/trace）；回滚/降级（开关/配置/迁移）。',
  '    配置/环境差异（配置项/多环境）；任务调度/定时（定时任务/重试/错过窗口）；数据生命周期（保留/归档/清理）；',
  '    存储容量/配额（配额边界/超配额）；升级/迁移（升级路径/回退/灰度）；消息/事件（送达/重复/乱序/失败重试）；',
  '    时间相关（时区/时钟偏移/超时/有效期）；资源回收（异常后连接/句柄/临时文件泄漏）；审计/合规（操作记录/脱敏/留存）。',
  '    适用且风险高的面补正式用例或“自测检查表”节点；用户要求留痕时才为不适用面写理由节点。',
  '   不机械套满测试类型，不把树结构当作覆盖矩阵；交叉维度放标题、标签或备注。',
  '6a. 用例标题表达一个主要测试目标：标题 = [前置状态] + 执行动作 + 主要结果（动作写出步骤，',
  '    "正确密码登录成功"缺动作不合格，"密码正确时点击登录按钮，跳转到工作台"合格）；',
  '    props.precondition 写执行前状态，无前置时写"无"；steps 每条一个动词开头的动作；expected 是整条用例',
  '    可观察、可判定的通过条件；多个断言可编号但必须共同证明同一目标，禁止"功能正常""符合预期"。',
  '    caseType 表达质量风险类型，testLevel 表达 ui/api/service/database/contract/e2e 测试层级；不得混用。',
  '    remark 记录稳定 CASE-*、可定位来源和 TCND-*；CASE-* 在同一文档内必须唯一，复用到不同用例属于错误；',
  '    TCND-* 表达一个可独立验证的行为或风险，不是模块名；同一 TCND-* 下超过 4 条用例时应拆分更细测试条件，',
  '    并确保这些用例在输入、状态、层级或判定点上确有差异。没有判定依据时标记待确认，不得臆测。',
  '6b. 节点标题保持简短（folder 建议 ≤ 20 字）：长背景说明、数据清单、参考材料写 folder 的 props.detail，',
  '    不要把长段落塞进节点 text（应用右侧「详情」可完整查看）。',
  '6c. 清理/删除：删节点用 delete_subtree，批量删用 delete_nodes；删整篇文档用 delete_document（不可恢复，先与用户确认）。',
  '    不允许绕过 MCP 直接改 .mindmap.json 文件；根节点不能删除。',
  '6d. 生成或修订用例后必须调用 validate_document；有 ERROR 必须修复后重跑，WARN 逐条判断并在备注说明理由。',
  ...priorityRubricText().split('\n'),
  '7. 用中文回复。',
  '',
  '如果导图按测试维度组织（一级节点 props.method 标注了测试方向），生成用例时：',
  '- 先 query_tree 读取各维度分支（props.method），严格按对应维度的设计方法展开',
  '- 保留已有维度节点，其下按稳定业务能力、用户任务或关键状态组织；同一层只表达一个维度',
  '- 文件夹层级按业务复杂度灵活调整，不超过 5 层；只有能提高执行或查找效率时才增加测试点文件夹，不为凑数量固定生成节点或用例',
  '- 约束细节见下方维度说明',
].join('\n');

interface ToolDef {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

/** 给 Claude 的工具定义（strict 形态；与 tools.ts 注册面语义一致） */
const TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_documents',
    description: '列出全部脑图文档（id/标题/更新时间/节点数），active=true 为当前激活文档',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'create_document',
    description: '新建一篇脑图文档并激活（出现在应用首页列表），返回 {id,title,rootId}；随后向 rootId add_subtree 填充内容',
    schema: {
      type: 'object',
      properties: { title: { type: 'string', description: '文档标题，作为根节点文本与文件名来源' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_skill',
    description:
      '获取 test-case-designer 技能的最新版本内容与版本信息。平台更新技能后调用即可加载最新规范，无需依赖本地副本',
    schema: {
      type: 'object',
      properties: { file: { type: 'string', description: '可选：技能包内附加文件相对路径（如 references/xxx.md）' } },
      additionalProperties: false,
    },
  },
  {
    name: 'open_document',
    description:
      '按 id 或 title 定位文档，返回其 id（后续节点工具用该 id 作为 docId）。title 支持精确匹配或空格分隔的多关键词模糊匹配（大小写不敏感、顺序无关，如「hades 用例」可命中「Hades Chat App 测试用例」）；多篇命中时报错并列出候选，需换更具体的名称或用 id 重试',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_document',
    description: '删除整篇文档（连同文件从目录/首页移除，不可恢复）。id 从 list_documents 获取；单文件模式不支持',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_tree',
    description: '创建/重置整棵脑图树（清空现有数据，仅当用户明确要求重置时使用）',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, rootText: { type: 'string' }, title: { type: 'string' } },
      required: ['docId', 'rootText'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_subtree',
    description: '在指定父节点下增量追加一棵子树（批量建模块/用例的主要入口），返回新分配 id',
    schema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: '目标文档 id（来自 create_document/open_document）' },
        parentId: { type: 'string', description: '父节点 id；根总是 n_0001' },
        subtree: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'folder=模块/路径，case=测试用例' },
            text: { type: 'string' },
            props: { type: 'object' },
            children: { type: 'array', items: { type: 'object' } },
          },
          required: ['type', 'text'],
          additionalProperties: false,
        },
      },
      required: ['docId', 'parentId', 'subtree'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_node',
    description: '更新节点文本或业务字段（props 浅合并，经类型校验）',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeId: { type: 'string' }, text: { type: 'string' }, props: { type: 'object' } },
      required: ['docId', 'nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_subtree',
    description: '删除节点及其整个子树（用例/空分组/模块均可；根节点不可删除）。清理重复或空节点时优先用此工具，不要直接改文件',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeId: { type: 'string' } },
      required: ['docId', 'nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_nodes',
    description: '批量删除节点及其子树（清理重复节点/空分组），返回 { removedIds, errors }；某个 id 失败不影响其余节点',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } } },
      required: ['docId', 'nodeIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_subtree',
    description: '移动节点到新的父节点下（防环校验）',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeId: { type: 'string' }, newParentId: { type: 'string' } },
      required: ['docId', 'nodeId', 'newParentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_tree',
    description: '读取树（可按 nodeId/type 过滤，超 limit 截断），返回 {nodes, truncated}',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeId: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_annotation',
    description: '给节点添加评审批注',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeId: { type: 'string' }, body: { type: 'string' }, createdBy: { type: 'string' } },
      required: ['docId', 'nodeId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_test_methods',
    description: '获取目标文档适用的测试设计方法约束；开始设计或大幅重组前调用',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_document',
    description: '对当前脑图执行 test-case-designer 质量门禁（结构/字段/追溯/重复/优先级/文本完整性），返回 errors/warnings/stats 与修复建议；生成或修订用例后必须调用',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_annotations',
    description: '列出批注（可按节点/状态过滤）',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, nodeId: { type: 'string' }, status: { type: 'string', enum: ['open', 'resolved'] } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply_annotation',
    description: '回复一条批注',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, annotationId: { type: 'string' }, body: { type: 'string' } },
      required: ['docId', 'annotationId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_annotation',
    description: '标记批注为已解决/重新打开',
    schema: {
      type: 'object',
      properties: { docId: { type: 'string' }, annotationId: { type: 'string' }, resolved: { type: 'boolean' } },
      required: ['docId', 'annotationId', 'resolved'],
      additionalProperties: false,
    },
  },
];

/** runToolLoop 依赖的最小 Anthropic 客户端形态（测试注入替身用） */
export interface AnthropicLike {
  messages: {
    stream(req: unknown): {
      on(ev: string, cb: (t: string) => void): void;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

/**
 * 跑一次完整工具循环；onText 流式回调模型文本（含中间解说）。
 * clientFactory 注入测试替身（默认 new Anthropic()）。
 */
export async function runToolLoop(
  executors: Map<string, ToolExecutor>,
  userMessage: string,
  opts: {
    model?: string;
    onText?: (t: string) => void;
    maxTurns?: number;
    systemExtra?: string;
    clientFactory?: () => AnthropicLike;
  } = {},
): Promise<{ reply: string; toolCalls: number }> {
  const client = opts.clientFactory?.() ?? new Anthropic();
  const model = opts.model ?? 'claude-opus-5-5';
  const maxTurns = opts.maxTurns ?? 24;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  const tools: Anthropic.Tool[] = TOOL_DEFS.map(({ name, description, schema }) => ({
    name,
    description,
    input_schema: schema as Anthropic.Tool.InputSchema,
    eager_input_streaming: true,
  }));

  let reply = '';
  let toolCalls = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 16000,
      system: opts.systemExtra ? SYSTEM_PROMPT + '\n\n' + opts.systemExtra : SYSTEM_PROMPT,
      tools,
      messages,
    });
    stream.on('text', (t) => opts.onText?.(t));
    const message = await stream.finalMessage();

    if (message.stop_reason === 'end_turn') {
      for (const b of message.content) if (b.type === 'text') reply += b.text;
      break;
    }
    if (message.stop_reason === 'refusal') {
      throw new Error('请求被安全策略拒绝');
    }
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUses.length) break;
    messages.push({ role: 'assistant', content: message.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      const exec = executors.get(tu.name);
      let content: string;
      if (!exec) {
        content = `ERROR: unknown tool ${tu.name}`;
      } else {
        try {
          const r = await exec(tu.input as Record<string, unknown>);
          content = r.content[0]?.text ?? 'OK';
        } catch (e) {
          content = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: content.startsWith('ERROR') });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply, toolCalls };
}
