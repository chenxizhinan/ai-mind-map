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
import { writeFileSync, readFileSync } from 'node:fs';
import { encodeXmind, encodeMarkdown, renderMethodPrompt, TEST_DESIGN_METHODS } from '@ai-mind-map/core';
import { singleDocContext, type DocContext } from './doc-manager.js';
import { getSkill, readSkillFile } from './skill.js';
// @ts-expect-error skill 脚本是无类型的 JS，动态能力在这里只用到 validateDocument 的返回形状
import { validateDocument } from '../../../.agents/skills/test-case-designer/scripts/validate-test-cases.js';

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

const DocIdSchema = z
  .string()
  .optional()
  .describe('目标文档 id（来自 list_documents）。管理多篇文档时必须显式传入，防止串文件。');

function err(e: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
}

export interface RegisterToolsOptions {
  /** 超过此节点数的 query_tree 响应做截断提示 */
  queryLimit?: number;
}

export type RegisterToolsCtx =
  | { store: () => import('@ai-mind-map/core').DocStore; filePath: string }
  | { docs: DocContext };

/** 解析联合 ctx：统一到 DocContext（旧形状适配为 SingleDocContext） */
function resolveCtx(opts: RegisterToolsCtx): DocContext {
  if ('docs' in opts) return opts.docs;
  return singleDocContext(null as never, opts.filePath, opts.store);
}

export function registerTools(
  server: McpServer,
  opts: RegisterToolsCtx & RegisterToolsOptions,
): void {
  server.tool(
    'get_skill',
    '获取 test-case-designer 技能的最新版本内容与版本信息。平台更新技能后，调用即可加载最新规范，无需依赖本地复制的副本',
    {
      file: z
        .string()
        .optional()
        .describe('可选：技能包内附加文件相对路径（如 references/xxx.md）；缺省返回 SKILL.md 主文件'),
    },
    async ({ file }) => {
      try {
        if (file) {
          const f = readSkillFile(file);
          if (!f) return err(new Error(`技能文件不存在: ${file}`));
          return { content: [{ type: 'text', text: f.content }] };
        }
        const s = getSkill();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ version: s.version, hash: s.hash, updatedAt: s.updatedAt, content: s.content }),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
  const ctx: DocContext = resolveCtx(opts);
  const store = (docId?: string): import('@ai-mind-map/core').DocStore => {
    if (docId) {
      const selected = ctx.byId(docId);
      if (!selected) throw new Error(`文档不存在: ${docId}。请先调用 list_documents 获取准确 id。`);
      return selected;
    }
    const docs = ctx.listDocs();
    if (docs.length > 1) {
      throw new Error('当前存在多篇文档，必须显式传入 docId；不要依赖共享的激活文档，以免串文件。');
    }
    return ctx.store();
  };
  const queryLimit = opts.queryLimit ?? 500;

  const persist = (docId?: string): void => {
    if (docId) {
      ctx.persist(docId);
      return;
    }
    const docs = ctx.listDocs();
    if (docs.length > 1) {
      throw new Error('当前存在多篇文档，必须显式传入 docId；拒绝按共享激活文档落盘。');
    }
    ctx.persist(docs[0]?.id);
  };

  server.tool(
    'create_tree',
    '创建/重置整棵脑图树（含根节点文本与文档标题）。会清空现有数据，谨慎调用。',
    {
      docId: DocIdSchema,
      rootText: z.string().describe('根节点文本（如产品/需求名）'),
      title: z.string().optional().describe('文档标题，默认同根文本'),
      rootType: z.string().optional().describe('根节点类型，默认 folder'),
    },
    async ({ docId, rootText, title, rootType }) => {
      try {
        const s = store(docId);
        const root = s.root;
        s.updateNode(root.id, { text: rootText });
        if (rootType) s.setNodeType(root.id, rootType);
        if (title) {
          s.document.meta.title = title;
        }
        persist(docId);
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
      docId: DocIdSchema,
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
    async ({ docId, parentId, subtree }) => {
      try {
        const r = store(docId).addSubtree(parentId, subtree);
        persist(docId);
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
      docId: DocIdSchema,
      nodeId: z.string(),
      text: z.string().optional(),
      props: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ docId, nodeId, text, props }) => {
      try {
        store(docId).updateNode(nodeId, { text, props });
        persist(docId);
        return { content: [{ type: 'text', text: 'OK' }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'delete_subtree',
    '删除节点及其整个子树（用例/空分组/模块均可；根节点不可删除）。清理重复或空节点时优先用此工具，不要直接改文件。返回被删除的节点 id。',
    { docId: DocIdSchema, nodeId: z.string() },
    async ({ docId, nodeId }) => {
      try {
        const r = store(docId).deleteSubtree(nodeId);
        persist(docId);
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'delete_nodes',
    '批量删除节点及其整个子树（清理重复节点/空分组用）。逐个执行并立即落盘，返回 { removedIds, errors }；某个 id 失败不影响其余节点，根节点不可删除。',
    { docId: DocIdSchema, nodeIds: z.array(z.string()).min(1).describe('要删除的节点 id 列表') },
    async ({ docId, nodeIds }) => {
      const removedIds: string[] = [];
      const errors: Array<{ nodeId: string; error: string }> = [];
      const s = store(docId);
      for (const nodeId of nodeIds) {
        try {
          removedIds.push(...s.deleteSubtree(nodeId).removedIds);
        } catch (e) {
          errors.push({ nodeId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (removedIds.length) persist(docId);
      return { content: [{ type: 'text', text: JSON.stringify({ removedIds, errors }) }] };
    },
  );

  server.tool(
    'move_subtree',
    '移动节点到新的父节点下（防环校验）。',
    { docId: DocIdSchema, nodeId: z.string(), newParentId: z.string() },
    async ({ docId, nodeId, newParentId }) => {
      try {
        store(docId).moveSubtree(nodeId, newParentId);
        persist(docId);
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
      docId: DocIdSchema,
      nodeId: z.string().optional().describe('从该节点开始返回（含其可见子树）'),
      type: z.string().optional().describe('只返回该类型的节点'),
      limit: z.number().optional().describe('返回条数上限，默认 500'),
    },
    async ({ docId, nodeId, type, limit }) => {
      try {
        const s = store(docId);
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
      docId: DocIdSchema,
      nodeId: z.string(),
      body: z.string().describe('批注内容'),
      createdBy: z.string().optional().describe('创建者标识，默认 "ai"'),
    },
    async ({ docId, nodeId, body, createdBy }) => {
      try {
        const ann = store(docId).addAnnotation(nodeId, body, createdBy ?? 'ai');
        persist(docId);
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
      docId: DocIdSchema,
      nodeId: z.string().optional(),
      status: z.enum(['open', 'resolved']).optional(),
    },
    async ({ docId, nodeId, status }) => {
      try {
        const list = store(docId).listAnnotations(nodeId, status);
        return { content: [{ type: 'text', text: JSON.stringify(list) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'reply_annotation',
    '回复一条批注（如说明已如何修改）。',
    { docId: DocIdSchema, annotationId: z.string(), body: z.string() },
    async ({ docId, annotationId, body }) => {
      try {
        const ann = store(docId).replyAnnotation(annotationId, body, 'ai');
        persist(docId);
        return { content: [{ type: 'text', text: JSON.stringify(ann) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'resolve_annotation',
    '标记批注为已解决/重新打开。',
    { docId: DocIdSchema, annotationId: z.string(), resolved: z.boolean() },
    async ({ docId, annotationId, resolved }) => {
      try {
        const ann = store(docId).setAnnotationStatus(annotationId, resolved ? 'resolved' : 'open');
        persist(docId);
        return { content: [{ type: 'text', text: JSON.stringify(ann) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ---------- 导入/导出 ----------

  server.tool(
    'export_xmind',
    '把当前导图导出为 .xmind 文件（Zen 格式；用例字段按 MeterSphere v3 中文键约定序列化为子主题，优先级为原生 marker）。',
    { docId: DocIdSchema, filePath: z.string().describe('输出的 .xmind 文件路径') },
    async ({ docId, filePath }) => {
      try {
        const s = store(docId);
        const bytes = encodeXmind(s.root, s.document.meta.title);
        writeFileSync(filePath, bytes);
        return { content: [{ type: 'text', text: `OK: ${filePath} (${bytes.length} bytes)` }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'export_markdown',
    '导出为幕布式 Markdown 大纲（根 = # 一级标题，子级 = ##/###，深层嵌套列表；case 字段为列表项）。',
    { docId: DocIdSchema, filePath: z.string().describe('输出的 .md 文件路径') },
    async ({ docId, filePath }) => {
      try {
        const md = encodeMarkdown(store(docId).root);
        writeFileSync(filePath, md, 'utf8');
        return { content: [{ type: 'text', text: `OK: ${filePath}` }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ---------- 文档管理（多文档模式） ----------

  server.tool(
    'list_documents',
    '列出 bridge/MCP 管理的全部脑图文档（id/标题/更新时间/节点数）。后续文档内工具应显式传入目标 docId。',
    {},
    async () => {
      return { content: [{ type: 'text', text: JSON.stringify(ctx.listDocs()) }] };
    },
  );

  server.tool(
    'create_document',
    '新建一篇脑图文档并返回 {id,title,rootId}。后续工具必须把返回的 id 作为 docId 显式传入。单文件（--file）模式不支持。',
    {
      title: z.string().describe('文档标题，作为根节点文本与文件名来源'),
    },
    async ({ title }) => {
      try {
        const r = ctx.createDoc({ title });
        ctx.persist();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(r) + '。已创建；后续工具请始终显式传入该 id 作为 docId。',
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'open_document',
    '按 id/title 定位并返回文档信息（title 支持空格分隔的多关键词模糊匹配，顺序无关）。为防多 Agent 串文件，后续文档内工具仍须显式传入返回的 id 作为 docId。',
    {
      id: z.string().optional().describe('文档 id（list_documents 返回的）'),
      title: z
        .string()
        .optional()
        .describe('文档标题或简称（多关键词空格分隔，全部命中即可，如「hades 用例」）'),
    },
    async ({ id, title }) => {
      try {
        const r = ctx.openDoc({ id, title });
        const s = ctx.store();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...r, nodeCount: ctx.listDocs().find((d) => d.active)?.nodeCount ?? 1 }),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    'delete_document',
    '删除整篇脑图文档（连同文件从目录/首页移除，不可恢复）。id 从 list_documents 获取；单文件（--file）模式不支持删除文档。',
    { id: z.string().describe('文档 id（list_documents 返回的 id）') },
    async ({ id }) => {
      try {
        const deleted = ctx.deleteDoc(id);
        if (!deleted) {
          throw new Error(`删除失败：文档「${id}」不存在，或当前为单文件模式（--file 不支持删除文档）`);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ deleted: id }) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ---------- 测试设计方法库（AI 生成用例的约束） ----------

  server.tool(
    'get_test_methods',
    [
      '获取测试用例设计方法库（各测试方向的设计方法与必查点）。',
      '在开始设计/生成用例之前先调用一次，之后按对应方法展开每条用例。',
      '若导图按测试维度组织（一级节点带 method 标注），返回的约束已按实际维度定制。多文档模式必须传 docId。',
    ].join(' '),
    { docId: DocIdSchema },
    async ({ docId }) => {
      // 从当前文档一级节点读维度标注：有标注 → 渲染针对性约束；无 → 全量方法
      const dims = store(docId)
        .root.children.map((c) => String((c.props as { method?: string }).method ?? ''))
        .filter(Boolean);
      return {
        content: [
          {
            type: 'text',
            text: [
              renderMethodPrompt(dims),
              '',
              '维度 method 标注对照：',
              ...TEST_DESIGN_METHODS.map((m) => `- ${m.key} = ${m.label}：${m.goal}`),
            ].join('\n'),
          },
        ],
      };
    },
  );

  server.tool(
    'validate_document',
    [
      '对 docId 指定的脑图执行 test-case-designer 质量门禁（结构/字段/追溯/重复/优先级/文本完整性）。',
      '生成或修订用例后必须调用；返回 errors/warnings/stats 与修复建议。',
      'errors 必须修复后重新写入；warnings 逐条判断并在备注说明理由。',
    ].join(' '),
    { docId: DocIdSchema },
    async ({ docId }) => {
      try {
        const doc = store(docId).toJSON();
        const result = validateDocument(doc);
        const summary = [
          `ERROR ${result.errors.length} 条；WARN ${result.warnings.length} 条`,
          `用例 ${result.stats.cases} 条；P0 ${result.stats.priorities.P0} / P1 ${result.stats.priorities.P1} / P2 ${result.stats.priorities.P2} / P3 ${result.stats.priorities.P3}`,
          `P0 占比 ${(result.stats.p0Ratio * 100).toFixed(1)}%；可追溯 ${(result.stats.traceabilityRatio * 100).toFixed(1)}%`,
        ].join(' · ');
        const formatIssues = (issues: Array<{ code: string; message: string; nodeId?: string; title?: string }>): string[] =>
          issues.map((i) => `- ${i.code}: ${i.message}${i.title ? `（「${i.title}」）` : ''}${i.nodeId ? ` [${i.nodeId}]` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: [
                summary,
                result.errors.length ? '\nERROR（必须修复）:' : '',
                ...formatIssues(result.errors),
                result.warnings.length ? '\nWARN（逐条判断）:' : '',
                ...formatIssues(result.warnings),
              ].filter(Boolean).join('\n'),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
}
