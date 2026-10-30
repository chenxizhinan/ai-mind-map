/**
 * Markdown 大纲互转（幕布式）。
 *
 * 结构约定：
 * - 根节点 → `# 标题`，二级 → `##`，依深度类推；深度超过 6 级后用嵌套列表续接。
 * - case 字段作为列表项输出：`**[P1]**` 优先级、`前置条件：…`、`步骤 1：…`、`预期：…`。
 * - 导入时反向解析：标题行建节点，缩进列表挂到最近的标题节点下；
 *   列表嵌套深度超过标题层级时还原为子节点。
 */
import type { MindNode } from './types.js';

export function encodeMarkdown(tree: MindNode): string {
  const lines: string[] = [];
  const p = tree.props as CaseProps;
  lines.push(`# ${tree.text}`);
  if (p.priority) lines.push(`**[P0]**`.replace('P0', p.priority));
  if (p.caseType) lines.push(`- 用例类型：${p.caseType}`);
  if (p.testLevel) lines.push(`- 测试层级：${p.testLevel}`);
  if (p.precondition) lines.push(`- 前置条件：${p.precondition}`);
  if (p.steps?.length) {
    p.steps.forEach((s, i) => {
      lines.push(`- 步骤 ${i + 1}：${s}`);
      if (p.expected && i === 0) lines.push(`  - 预期：${p.expected}`);
    });
  }
  if (p.expected && !p.steps?.length) lines.push(`- 预期：${p.expected}`);
  if (p.remark ?? p.note) lines.push(`- 备注：${p.remark ?? p.note}`);

  const emit = (n: MindNode, depth: number): void => {
    for (const c of n.children ?? []) {
      const cp = c.props as CaseProps;
      const prefix = depth <= 5 ? '#'.repeat(depth + 1) + ' ' : '';
      if (prefix) {
        lines.push('');
        lines.push(`${prefix}${cp.priority ? `**[${cp.priority}]** ` : ''}${c.text}`);
      } else {
        lines.push(`- ${cp.priority ? `**[${cp.priority}]** ` : ''}${c.text}`);
      }
      if (cp.precondition) lines.push(`  - 前置条件：${cp.precondition}`);
      if (cp.caseType) lines.push(`  - 用例类型：${cp.caseType}`);
      if (cp.testLevel) lines.push(`  - 测试层级：${cp.testLevel}`);
      if (cp.steps?.length) {
        cp.steps.forEach((s, i) => {
          lines.push(`${prefix ? '  ' : '  '}- 步骤 ${i + 1}：${s}`);
          if (cp.expected && i === 0) lines.push(`    - 预期：${cp.expected}`);
        });
      }
      if (cp.expected && !cp.steps?.length) lines.push(`  - 预期：${cp.expected}`);
      if (cp.remark ?? cp.note) lines.push(`  - 备注：${cp.remark ?? cp.note}`);
      emit(c, depth + 1);
    }
  };
  emit(tree, 1);
  return lines.join('\n') + '\n';
}

interface CaseProps {
  priority?: string;
  caseType?: string;
  testLevel?: string;
  precondition?: string;
  steps?: string[];
  expected?: string;
  note?: string;
  remark?: string;
}

/** 解析幕布式 Markdown 大纲为树（无法识别的字段行丢弃，返回 warnings） */
export function decodeMarkdown(md: string): { tree: MindNode; warnings: string[] } {
  const lines = md.split('\n');
  const warnings: string[] = [];
  const root: MindNode = { id: '', type: 'folder', text: '(root)', props: {}, children: [] };
  // 节点栈：index 0 是 root；每个元素 { node, depth }，depth 0 = 标题层级 1
  const stack: Array<{ node: MindNode; depth: number }> = [{ node: root, depth: 0 }];
  let lastHeadingDepth = 0;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // ATX 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const depth = h[1].length;
      const { text, props } = parseNodeText(h[2]);
      const node: MindNode = { id: '', type: 'folder', text, props, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const parent = stack[stack.length - 1].node;
      parent.children!.push(node);
      stack.push({ node, depth });
      lastHeadingDepth = depth;
      continue;
    }

    // 列表项（含嵌套缩进）
    const li = /^(\s*)-\s+(.*)$/.exec(line);
    if (li) {
      const indent = li[1].length;
      const { text, props } = parseNodeText(li[2]);
      // 字段列表项 → 挂到最近节点的 props
      const target = stack[stack.length - 1].node;
      if (text.startsWith('前置条件：')) {
        target.props.precondition = text.slice(5);
        continue;
      }
      if (text.startsWith('用例类型：')) {
        target.props.caseType = text.slice(5);
        continue;
      }
      if (text.startsWith('测试层级：')) {
        target.props.testLevel = text.slice(5);
        continue;
      }
      if (text.startsWith('预期：')) {
        target.props.expected = text.slice(3);
        continue;
      }
      if (text.startsWith('备注：')) {
        target.props.remark = text.slice(3);
        continue;
      }
      const sm = /^步骤\s*\d+：(.*)$/.exec(text);
      if (sm) {
        const t = target.props as { steps?: string[] };
        t.steps = t.steps ?? [];
        t.steps.push(sm[1]);
        continue;
      }
      const node: MindNode = { id: '', type: 'folder', text, props, children: [] };
      // 缩进层级 → 找正确的父节点：弹出比当前缩进更深或同级的节点
      while (stack.length > 1 && (stack[stack.length - 1].depth as number) > lastHeadingDepth + Math.floor(indent / 2)) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].node;
      parent.children!.push(node);
      stack.push({ node, depth: lastHeadingDepth + Math.floor(indent / 2) });
      continue;
    }

    warnings.push(`忽略无法解析的行：${line.slice(0, 40)}`);
  }

  if (root.children?.length === 1) {
    const only = root.children[0];
    return { tree: only, warnings };
  }
  return { tree: root, warnings };
}

/** 提取 `**[P1]** 标题` 前缀 */
function parseNodeText(s: string): { text: string; props: { priority?: string } } {
  const m = /^\*\*\[(P[0-3])\]\*\*\s*(.*)$/.exec(s);
  if (m) return { text: m[2], props: { priority: m[1] } };
  return { text: s, props: {} };
}
