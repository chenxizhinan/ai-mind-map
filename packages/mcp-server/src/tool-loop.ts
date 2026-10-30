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
  '1. 会话开始先 list_documents 了解现有文档；用户要求生成新的用例集/新脑图时务必 create_document 新建文档（会出现在应用首页），严禁往现有文档里灌或覆盖；',
  '   用户要求更新某篇既有文档时，先 open_document（title 或 id）再操作。',
  '2. 生成用例前先 query_tree（limit 30）了解激活文档的现有结构，避免重复、对齐既有模块命名。',
  '3. 批量建用例用 add_subtree 一次提交一棵完整子树（模块 folder 下挂 case 数组）。',
  '4. 激活文档的根节点 id 见 list_documents/create_document/open_document 返回的 rootId（新文档为 n_0001）；模块建完后用返回的 nodeId 继续挂用例。',
  '5. 修改完成后用 1-3 句话总结，不要输出大段 JSON。',
  '6. 先从事实来源提取测试条件、风险和判定依据；按执行入口、稳定业务能力或关键状态组织 folder，叶子用 case。',
  '   不机械套满测试类型，不把树结构当作覆盖矩阵；交叉维度放标题、标签或备注。',
  '6a. 用例标题表达一个主要测试目标：标题 = [前置状态] + 执行动作 + 主要结果（动作写出步骤，',
  '    "正确密码登录成功"缺动作不合格，"密码正确时点击登录按钮，跳转到工作台"合格）；',
  '    props.precondition 写执行前状态，无前置时写"无"；steps 每条一个动词开头的动作；expected 是整条用例',
  '    可观察、可判定的通过条件；多个断言可编号但必须共同证明同一目标，禁止"功能正常""符合预期"。',
  '    caseType 表达质量风险类型，testLevel 表达 ui/api/service/database/contract/e2e 测试层级；不得混用。',
  '    remark 记录稳定 CASE-*、可定位来源和 TCND-*；没有判定依据时标记待确认，不得臆测。',
  '6b. 节点标题保持简短（folder 建议 ≤ 20 字）：长背景说明、数据清单、参考材料写 folder 的 props.detail，',
  '    不要把长段落塞进节点 text（应用右侧「详情」可完整查看）。',
  '6c. 清理/删除：删节点用 delete_subtree，批量删用 delete_nodes；删整篇文档用 delete_document（不可恢复，先与用户确认）。',
  '    不允许绕过 MCP 直接改 .mindmap.json 文件；根节点不能删除。',
  ...priorityRubricText().split('\n'),
  '7. 用中文回复。',
  '',
  '如果导图按测试维度组织（一级节点 props.method 标注了测试方向），生成用例时：',
  '- 先 query_tree 读取各维度分支（props.method），严格按对应维度的设计方法展开',
  '- 保留已有维度节点，其下按稳定业务能力、用户任务或关键状态组织；同一层只表达一个维度',
  '- 默认控制在 2-4 层文件夹，只有能提高执行或查找效率时才增加测试点文件夹，不为凑数量固定生成节点或用例',
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
    name: 'open_document',
    description: '切换激活文档（后续节点工具作用于它）。id 与 title 二选一；标题重名时报错列出候选 id，用 id 重试',
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
      properties: { rootText: { type: 'string' }, title: { type: 'string' } },
      required: ['rootText'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_subtree',
    description: '在指定父节点下增量追加一棵子树（批量建模块/用例的主要入口），返回新分配 id',
    schema: {
      type: 'object',
      properties: {
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
      required: ['parentId', 'subtree'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_node',
    description: '更新节点文本或业务字段（props 浅合并，经类型校验）',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, text: { type: 'string' }, props: { type: 'object' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_subtree',
    description: '删除节点及其整个子树（用例/空分组/模块均可；根节点不可删除）。清理重复或空节点时优先用此工具，不要直接改文件',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_nodes',
    description: '批量删除节点及其子树（清理重复节点/空分组），返回 { removedIds, errors }；某个 id 失败不影响其余节点',
    schema: {
      type: 'object',
      properties: { nodeIds: { type: 'array', items: { type: 'string' } } },
      required: ['nodeIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_subtree',
    description: '移动节点到新的父节点下（防环校验）',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, newParentId: { type: 'string' } },
      required: ['nodeId', 'newParentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_tree',
    description: '读取树（可按 nodeId/type 过滤，超 limit 截断），返回 {nodes, truncated}',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: false,
    },
  },
  {
    name: 'add_annotation',
    description: '给节点添加评审批注',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, body: { type: 'string' }, createdBy: { type: 'string' } },
      required: ['nodeId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_annotations',
    description: '列出批注（可按节点/状态过滤）',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, status: { type: 'string', enum: ['open', 'resolved'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'reply_annotation',
    description: '回复一条批注',
    schema: {
      type: 'object',
      properties: { annotationId: { type: 'string' }, body: { type: 'string' } },
      required: ['annotationId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_annotation',
    description: '标记批注为已解决/重新打开',
    schema: {
      type: 'object',
      properties: { annotationId: { type: 'string' }, resolved: { type: 'boolean' } },
      required: ['annotationId', 'resolved'],
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
