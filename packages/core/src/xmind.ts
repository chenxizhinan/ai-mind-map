/**
 * XMind 导入/导出。
 *
 * 格式事实（docs/research/large-scale-rendering-and-testcase-tools.md §3，源码级核实）：
 * - .xmind 是 zip 包。新格式（XMind 2020+/Zen）内容在 content.json，
 *   旧格式（XMind 8）在 content.xml。本实现：导出 Zen 格式（当前主流），
 *   导入同时兼容 Zen（content.json）与 XMind 8（content.xml）。
 * - Zen topic: { id, title, children: { attached: [...] }, markers?: [{ markerId }] }
 * - 优先级：Zen markerId 'priority-1'..'priority-4' → P0-P3；
 *   MeterSphere 约定用例字段为子主题（前置条件：/步骤描述：/预期结果：）
 *
 * 依赖 fflate（~8KB gzip，无依赖，浏览器/Node 通用）。
 */
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import type { MindNode } from './types.js';
import type { NodeTypeRegistry } from './node-type.js';

export interface XmindImportResult {
  tree: MindNode;
  warnings: string[];
}

const TO_P: Record<string, string> = {
  'priority-1': 'P0',
  'priority-2': 'P1',
  'priority-3': 'P2',
  'priority-4': 'P3',
};
const TO_MARKER: Record<string, string> = {
  P0: 'priority-1',
  P1: 'priority-2',
  'P2': 'priority-3',
  P3: 'priority-4',
};

interface ZenTopic {
  id?: string;
  title?: string;
  children?: { attached?: ZenTopic[] };
  markers?: Array<{ markerId: string }>;
}

// ---------- 导出：MindNode → Zen content.json ----------

export function buildXmindRootTopic(tree: MindNode): ZenTopic {
  const toZen = (n: MindNode): ZenTopic => {
    const p = n.props as {
      priority?: string;
      caseType?: string;
      testLevel?: string;
      precondition?: string;
      steps?: string[];
      expected?: string;
      note?: string;
      remark?: string;
    };
    const attached: ZenTopic[] = (n.children ?? []).map(toZen);
    // case 字段序列化为子主题，对齐 MeterSphere v3 中文键约定
    if (p.caseType) attached.push({ id: `${n.id}_type`, title: `用例类型：${p.caseType}` });
    if (p.testLevel) attached.push({ id: `${n.id}_level`, title: `测试层级：${p.testLevel}` });
    if (p.precondition) attached.push({ id: `${n.id}_pre`, title: `前置条件：${p.precondition}` });
    if (p.steps?.length) {
      const group: ZenTopic = { id: `${n.id}_steps`, title: '步骤描述：' };
      group.children = {
        attached: p.steps.map((s, i) => ({
          id: `${n.id}_s${i}`,
          title: `步骤${i + 1}：${s}`,
          ...(p.expected && i === 0
            ? { children: { attached: [{ id: `${n.id}_exp`, title: `预期结果：${p.expected}` }] } }
            : {}),
        })),
      };
      attached.push(group);
    } else if (p.expected) {
      attached.push({ id: `${n.id}_exp`, title: `预期结果：${p.expected}` });
    }
    if (p.remark ?? p.note) attached.push({ id: `${n.id}_note`, title: `备注：${p.remark ?? p.note}` });

    const zen: ZenTopic = { id: n.id, title: n.text };
    if (p.priority && TO_MARKER[p.priority]) {
      zen.markers = [{ markerId: TO_MARKER[p.priority] }];
    }
    if (attached.length) zen.children = { attached };
    return zen;
  };
  return toZen(tree);
}

/** 打包 .xmind（Zen 格式）二进制 */
export function encodeXmind(tree: MindNode, title = 'sheet1'): Uint8Array {
  const content = JSON.stringify(
    [
      {
        id: 'sheet1',
        class: 'sheet',
        title,
        rootTopic: buildXmindRootTopic(tree),
      },
    ],
    null,
    2,
  );
  const manifest = JSON.stringify({
    'file-entries': { 'content.json': {}, 'metadata.json': {} },
  });
  const metadata = JSON.stringify({ creator: { name: 'ai-mind-map', version: '0.1.0' } });
  return zipSync({
    'content.json': strToU8(content),
    'metadata.json': strToU8(metadata),
    'manifest.json': strToU8(manifest),
  });
}

// ---------- 导入 ----------

/** 从 .xmind 二进制解析树（自动识别 Zen content.json / XMind 8 content.xml） */
export function decodeXmind(
  data: Uint8Array,
  registry: NodeTypeRegistry,
): XmindImportResult {
  const files = unzipSync(data);
  const warnings: string[] = [];

  if (files['content.json']) {
    const sheets = JSON.parse(strFromU8(files['content.json'])) as Array<{
      rootTopic?: ZenTopic;
    }>;
    const root = sheets[0]?.rootTopic;
    if (!root) throw new Error('content.json 中没有 rootTopic');
    return { tree: zenToNode(root, registry, warnings), warnings };
  }

  if (files['content.xml']) {
    const xml = strFromU8(files['content.xml']);
    return { tree: parseXmind8Xml(xml, registry, warnings), warnings };
  }

  throw new Error('不是有效的 .xmind 文件（缺少 content.json / content.xml）');
}

function zenToNode(
  t: ZenTopic,
  registry: NodeTypeRegistry,
  warnings: string[],
): MindNode {
  // 标记用例子主题（前置条件：/步骤描述：/预期结果：/备注：）并抽出字段
  const fields = extractCaseFields(t);
  const priority = t.markers?.find((m) => TO_P[m.markerId])?.markerId;
  const kids = (t.children?.attached ?? []).filter(
    (c) => !isCaseFieldTopic(c.title ?? ''),
  );

  return {
    id: t.id ?? '',
    type: kids.length === 0 && (priority || fields) ? 'case' : 'folder',
    text: (t.title ?? '').trim(),
    props: {
      ...(priority ? { priority: TO_P[priority] } : {}),
      ...fields,
    },
    children: kids.map((c) => zenToNode(c, registry, warnings)),
  } as MindNode;
}

/** MeterSphere v3 中文键前缀 */
function isCaseFieldTopic(title: string): boolean {
  return /^(用例类型：|测试层级：|前置条件：|步骤描述：|预期结果：|备注：|步骤\d+：)/.test(title);
}

function extractCaseFields(t: ZenTopic): Partial<{
  precondition: string;
  caseType: string;
  testLevel: string;
  steps: string[];
  expected: string;
  remark: string;
}> {
  const out: Partial<{ precondition: string; caseType: string; testLevel: string; steps: string[]; expected: string; remark: string }> = {};
  for (const c of t.children?.attached ?? []) {
    const title = c.title ?? '';
    if (title.startsWith('用例类型：')) out.caseType = title.slice(5);
    else if (title.startsWith('测试层级：')) out.testLevel = title.slice(5);
    else if (title.startsWith('前置条件：')) out.precondition = title.slice(5);
    else if (title.startsWith('预期结果：')) out.expected = title.slice(5);
    else if (title.startsWith('备注：')) out.remark = title.slice(3);
    else if (title.startsWith('步骤描述：')) {
      const steps: string[] = [];
      for (const s of c.children?.attached ?? []) {
        const st = s.title ?? '';
        if (/^步骤\d+：/.test(st)) {
          steps.push(st.replace(/^步骤\d+：/, ''));
          for (const e of s.children?.attached ?? []) {
            const et = e.title ?? '';
            if (et.startsWith('预期结果：') && !out.expected) out.expected = et.slice(5);
          }
        } else {
          steps.push(st);
        }
      }
      out.steps = steps;
    }
  }
  return out;
}

// ---------- XMind 8 (content.xml) ----------

function parseXmind8Xml(
  xml: string,
  registry: NodeTypeRegistry,
  warnings: string[],
): MindNode {
  // 轻量解析：只找 topic 的 text 与嵌套 topics、priority 标记。
  // 用 DOMParser（浏览器）或正则降级（Node）——这里用浏览器 DOMParser，
  // Node 端导入由 MCP server 在浏览器外不提供（导出足够），标注于 README。
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.querySelector('topic');
  if (!root) throw new Error('content.xml 中没有 topic');
  const walk = (el: Element): MindNode => {
    const titleEl = el.querySelector(':scope > title');
    const title = titleEl?.textContent ?? '';
    const markerId = el.querySelector('marker-ref')?.getAttribute('marker-id') ?? undefined;
    const childrenEls = [...el.children]
      .filter((x) => x.tagName === 'children')
      .flatMap((x) => [...x.children])
      .flatMap((x) => [...x.children])
      .filter((x) => x.tagName === 'topic');
    const priority = markerToPriority(markerId);
    return {
      id: '',
      type: childrenEls.length === 0 ? 'case' : 'folder',
      text: title.trim(),
      props: { ...(priority ? { priority } : {}) },
      children: childrenEls.map(walk),
    } as MindNode;
  };
  return walk(root);
}

function markerToPriority(markerId: string | undefined): string | undefined {
  return markerId && TO_P[markerId] ? TO_P[markerId] : undefined;
}
