/**
 * Claude 工具循环：把 MCP 工具面暴露给 Claude，跑多轮 agentic 循环。
 *
 * 复用 registerTools 的处理函数（stub server 收集器，与 tools.test.ts 同模式），
 * 因此工具行为、校验、落盘与 stdio MCP server 完全一致。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DocStore } from '@ai-mind-map/core';
import { registerTools } from './tools.js';

export type ToolExecutor = (args: Record<string, unknown>) => Promise<{
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
}>;

/** 把 registerTools 的 MCP 注册面变成可直接调用的工具执行器 */
export function collectToolExecutors(store: () => DocStore, filePath: string): Map<string, ToolExecutor> {
  const tools = new Map<string, ToolExecutor>();
  const stubServer = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolExecutor) => {
      tools.set(name, handler);
    },
  };
  registerTools(stubServer as never, { store, filePath });
  return tools;
}

const SYSTEM_PROMPT = [
  '你是测试用例脑图的 AI 助手，可以直接用工具读写当前导图。',
  '',
  '工作方式：',
  '1. 生成用例前先 query_tree（limit 30）了解现有结构，避免重复、对齐既有模块命名。',
  '2. 批量建用例用 add_subtree 一次提交一棵完整子树（模块 folder 下挂 case 数组）。',
  '3. 根节点 id 总是 n_0001；模块建完后用返回的 nodeId 继续挂用例。',
  '4. 修改完成后用 1-3 句话总结，不要输出大段 JSON。',
  '5. 按功能模块组织 folder，叶子用 case，props 带优先级 P0-P3，覆盖正常流/边界/异常。',
  '6. 用中文回复。',
  '',
  '如果导图按测试维度组织（一级节点 props.method 标注了测试方向），生成用例时：',
  '- 先 query_tree 读取各维度分支（props.method），严格按对应维度的设计方法展开用例',
  '- 每条用例挂在它检验的维度分支下；约束细节见下方维度说明',
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
    description: '删除节点及其整个子树',
    schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
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

/**
 * 跑一次完整工具循环；onText 流式回调模型文本（含中间解说）。
 */
export async function runToolLoop(
  executors: Map<string, ToolExecutor>,
  userMessage: string,
  opts: { model?: string; onText?: (t: string) => void; maxTurns?: number; systemExtra?: string } = {},
): Promise<{ reply: string; toolCalls: number }> {
  const client = new Anthropic();
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
