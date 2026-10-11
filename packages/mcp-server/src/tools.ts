/**
 * MCP 工具注册：树构建、节点编辑、批注三类工具。
 *
 * 设计原则（对应 architecture-draft.md §4）：
 * - 每次调用都经 NodeTypeRegistry 校验并立即落盘。
 * - query_tree 支持按子树/类型过滤，避免超大响应撑爆上下文。
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadOrCreate, save } from './store.js';

interface SubtreeInput {
  type: string;
  text: string;
  id?: string;
  props?: Record<string, unknown>;
  children?: SubtreeInput[];
}

const TreeSubtreeSchema: z.ZodType<SubtreeInput> = z.object({
  type: z.string(),
  text: z.string(),
  id: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  children: z.lazy(() => z.array(TreeSubtreeSchema)).optional(),
});

function err(e: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
}

export interface RegisterToolsOptions {
  /** 超过此节点数的 query_tree 响应做截断提示 */
  queryLimit?: number;
}

export function registerTools(
  server: McpServer,
  opts: { store: () => import('@ai-mind-map/core').DocStore; filePath: string } & RegisterToolsOptions,
): void {
  const { store, filePath } = opts;
  const queryLimit = opts.queryLimit ?? 500;

  const persist = (): void => save(store(), filePath);

  server.tool(
    'create_tree',
    '创建/重置整棵脑图树（含根节点文本与文档标题）。会清空现有数据，谨慎调用。',
    {
      rootText: z.string().describe('根节点文本（如产品/需求名）'),
      title: z.string().optional().describe('文档标题，默认同根文本'),
      rootType: z.string().optional().describe('根节点类型，默认 folder'),
    },
    async ({ rootText, title, rootType }) => {
      try {
        const s = store();
        const root = s.root;
        s.updateNode(root.id, { text: rootText });
        if (rootType) s.setNodeType(root.id, rootType);
        if (title) {
          s.document.meta.title = title;
        }
        persist();
        return { content: [{ type: 'text', text: `OK. root=${root.id}` }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'add_subtree',
    '在指定父节点下增量追加一棵子树（批量建模块/用例的主要入口）。未提供 id 的节点由服务端分配，返回全部新分配 id。',
    {
      parentId: z.string().describe('父节点 id'),
      subtree: z
        .object({
          type: z.string().describe('节点类型（需已注册，如 folder/case）'),
          text: z.string(),
          props: z.record(z.string(), z.unknown()).optional(),
          children: z.array(z.unknown()).optional(),
        })
        .describe('子树定义'),
    },
    async ({ parentId, subtree }) => {
      try {
        const r = store().addSubtree(parentId, subtree);
        persist();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(r),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'update_node',
    '更新节点文本或业务字段（props 会被对应 NodeType 校验并浅合并）。',
    {
      nodeId: z.string(),
      text: z.string().optional(),
      props: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ nodeId, text, props }) => {
      try {
        store().updateNode(nodeId, { text, props });
        persist();
        return { content: [{ type: 'text', text: 'OK' }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'delete_subtree',
    '删除节点及其整个子树。',
    { nodeId: z.string() },
    async ({ nodeId }) => {
      try {
        const r = store().deleteSubtree(nodeId);
        persist();
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'move_subtree',
    '移动节点到新的父节点下（防环校验）。',
    { nodeId: z.string(), newParentId: z.string() },
    async ({ nodeId, newParentId }) => {
      try {
        store().moveSubtree(nodeId, newParentId);
        persist();
        return { content: [{ type: 'text', text: 'OK' }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'query_tree',
    '读取树。可指定 nodeId（默认根）与 type 过滤；返回扁平节点数组，超过 queryLimit 条时截断。',
    {
      nodeId: z.string().optional().describe('从该节点开始返回（含其可见子树）'),
      type: z.string().optional().describe('只返回该类型的节点'),
      limit: z.number().optional().describe('返回条数上限，默认 500'),
    },
    async ({ nodeId, type, limit }) => {
      try {
        const s = store();
        const startId = nodeId ?? s.root.id;
        const start = s.getNode(startId);
        if (!start) throw new Error(`node not found: ${startId}`);
        const max = limit ?? queryLimit;
        const out: Array<Record<string, unknown>> = [];
        const walk = (n: { id: string; type: string; text: string; props: Record<string, unknown>; children?: unknown[] }): void => {
          if (out.length >= max) return;
          if (!type || n.type === type) {
            out.push({ id: n.id, type: n.type, text: n.text, props: n.props });
          }
          for (const c of (n.children ?? []) as typeof n[]) walk(c);
        };
        walk(start);
        const truncated = out.length >= max;
        const body = truncated
          ? { truncated: true, count: out.length, hint: 'use nodeId/limit/type to narrow, or page through' }
          : { truncated: false, count: out.length };
        return { content: [{ type: 'text', text: JSON.stringify({ ...body, nodes: out }) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ---------- 批注 ----------

  server.tool(
    'add_annotation',
    '给节点添加评审批注（AI 自查标注或回复评审意见均可）。',
    {
      nodeId: z.string(),
      body: z.string().describe('批注内容'),
      createdBy: z.string().optional().describe('创建者标识，默认 "ai"'),
    },
    async ({ nodeId, body, createdBy }) => {
      try {
        const ann = store().addAnnotation(nodeId, body, createdBy ?? 'ai');
        persist();
        return { content: [{ type: 'text', text: JSON.stringify(ann) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'list_annotations',
    '列出批注，可按节点/状态过滤。修订用例前应先读人留下的 open 批注。',
    {
      nodeId: z.string().optional(),
      status: z.enum(['open', 'resolved']).optional(),
    },
    async ({ nodeId, status }) => {
      try {
        const list = store().listAnnotations(nodeId, status);
        return { content: [{ type: 'text', text: JSON.stringify(list) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'reply_annotation',
    '回复一条批注（如说明已如何修改）。',
    { annotationId: z.string(), body: z.string() },
    async ({ annotationId, body }) => {
      try {
        const ann = store().replyAnnotation(annotationId, body, 'ai');
        persist();
        return { content: [{ type: 'text', text: JSON.stringify(ann) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'resolve_annotation',
    '标记批注为已解决/重新打开。',
    { annotationId: z.string(), resolved: z.boolean() },
    async ({ annotationId, resolved }) => {
      try {
        const ann = store().setAnnotationStatus(annotationId, resolved ? 'resolved' : 'open');
        persist();
        return { content: [{ type: 'text', text: JSON.stringify(ann) }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
