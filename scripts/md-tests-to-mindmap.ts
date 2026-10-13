/**
 * md-tests-to-mindmap：把「表格型测试用例 Markdown」转换为 ai-mind-map 脑图 JSON。
 *
 * 通用规则（不绑定具体项目）：
 * - `## N. 章节` → depth1 folder；`### N.M 小节` → depth2 folder
 * - 表头自适应：ID/级别/场景分类/用例标题/预期结果 列序变化、
 *   有无「页面/路由」「验证链路」列都能解析
 * - case props：priority（P0-P3）、scenario（场景分类）、expected、note（ID + 页面/链路）
 * - 无用例表格的章节（原则/矩阵/门禁类）自动跳过
 *
 * 用法：
 *   npx tsx scripts/md-tests-to-mindmap.ts <测试用例.md> <输出.json> [--root 根名称]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DocStore, NodeTypeRegistry, registerBuiltinTypes, type MindNode } from '@ai-mind-map/core';

const args = process.argv.slice(2);
const mdPath = args[0];
const outPath = args[1];
const rootFlag = args.indexOf('--root');
const rootName = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
if (!mdPath || !outPath) {
  console.error('用法: npx tsx scripts/md-tests-to-mindmap.ts <测试用例.md> <输出.json> [--root 根名称]');
  process.exit(1);
}

const md = readFileSync(mdPath, 'utf8');

interface Case {
  id: string;
  level: string;
  category: string;
  extra?: string;
  title: string;
  expected: string;
}

function parseCaseRow(cells: string[], headers: string[]): Case | null {
  const idxOf = (name: string): number => headers.findIndex((h) => h.includes(name));
  // 6 列变体（| 用例 | 级别 | 场景分类 | 页面/路由 | 标题 | 预期 |）首列叫「用例」；
  // 5 列标准首列叫「ID」。两者都落在第 0 列。
  const iId = idxOf('ID') >= 0 ? idxOf('ID') : 0;
  const id = (cells[iId] ?? '').replace(/`/g, '').trim();
  const levelRaw = (cells[idxOf('级别')] ?? '').trim();
  const level = /^[Pp][0-3]$/.test(levelRaw) ? levelRaw.toUpperCase() : 'P2';
  const category = (cells[idxOf('场景分类')] ?? '').trim();
  const iExtra = idxOf('页面/路由') >= 0 ? idxOf('页面/路由') : idxOf('验证链路');
  const extra = iExtra >= 0 ? (cells[iExtra] ?? '').replace(/`/g, '').trim() : undefined;
  const iTitle = idxOf('用例标题');
  const iExpected = idxOf('预期结果') >= 0 ? idxOf('预期结果') : idxOf('验证链路');
  const title = (cells[iTitle >= 0 ? iTitle : cells.length - 2] ?? '').replace(/`/g, '').trim();
  const expected = (cells[iExpected >= 0 ? iExpected : cells.length - 1] ?? '').replace(/`/g, '').trim();
  if (!title) return null;
  return { id, level, category, extra, title, expected };
}

/** 场景分类 → 内置 caseType 枚举（CASE_TYPES key）；未知分类返回 undefined */
function categoryToCaseType(c: string): string | undefined {
  const m: Record<string, string> = {
    '正常': 'functional',
    '边界': 'boundary',
    '异常': 'exception',
    '权限': 'security',
    '安全': 'security',
    '隔离': 'workflow',
    '兼容/恢复': 'compatibility',
    '性能/容量': 'performance',
    '并发': 'data',
  };
  return m[c];
}

function buildTree(): { root: MindNode; stats: { sections: number; cases: number; warnings: string[] } } {
  const warnings: string[] = [];
  const root: MindNode = { id: '', type: 'folder', text: rootName ?? '测试用例导图', props: {}, children: [] };
  const stats = { sections: 0, cases: 0, warnings };
  let h2Node: MindNode | null = null;
  let h3Node: MindNode | null = null;
  let headers: string[] | null = null;
  const fileTitle = /^#\s+(.+)$/m.exec(md)?.[1];

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      h2Node = { id: '', type: 'folder', text: h2[1].replace(/^\d+\.\s*/, ''), props: {}, children: [] };
      root.children!.push(h2Node);
      h3Node = null;
      headers = null;
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      if (!h2Node) continue;
      h3Node = { id: '', type: 'folder', text: h3[1].replace(/^\d+\.\d+\s*/, ''), props: {}, children: [] };
      h2Node.children!.push(h3Node);
      headers = null;
      continue;
    }
    // 表头行：必须同时含「级别」和「场景分类」才是用例表
    if (!headers && /^\|/.test(line) && /级别/.test(line) && /场景分类/.test(line)) {
      headers = line.split('|').slice(1, -1).map((s) => s.trim());
      continue;
    }
    if (headers && h2Node) {
      if (/^\|\s*[-\s|]+\|$/.test(line)) continue; // 分隔行
      if (!/^\|\s*`/.test(line)) {
        if (!line.trim().startsWith('|')) headers = null; // 表格结束
        continue;
      }
      const cells = line.split('|').slice(1, -1).map((s) => s.trim());
      const c = parseCaseRow(cells, headers);
      if (!c) {
        warnings.push(`无法解析: ${line.slice(0, 60)}`);
        continue;
      }
      const parent = h3Node ?? h2Node;
      parent.children!.push({
        id: '',
        type: 'case',
        text: c.title,
        props: {
          priority: c.level,
          caseType: categoryToCaseType(c.category),
          expected: c.expected || undefined,
          // 原始 ID + 页面/链路放 remark（CaseProps 白名单字段）；分类原文也保留在 remark 头部
          remark: [c.id, c.category, c.extra].filter(Boolean).join(' · ') || undefined,
        },
        children: [],
      });
      stats.cases++;
      continue;
    }
  }
  // 清理空章节：只清「空 folder」，不能动 case 叶子
  for (const h2 of root.children ?? []) {
    h2.children = (h2.children ?? []).filter(
      (c) => c.type !== 'folder' || (c.children ?? []).length > 0,
    );
  }
  root.children = (root.children ?? []).filter((h2) => (h2.children ?? []).length > 0);
  stats.sections = (root.children ?? []).length;
  if (fileTitle) root.props = { note: `来源：${fileTitle}` };
  return { root, stats };
}

const { root, stats } = buildTree();

// 全树分配 id（fromJSON/normalizeNode 不分配 id，空 id 会让浏览器选中/编辑失效）
{
  let seq = 1;
  const walk = (n: MindNode): void => {
    n.id = `n_${String(seq++).padStart(4, '0')}`;
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
}

// 经 DocStore 校验（与 MCP/浏览器写入同一套校验）
const registry = new NodeTypeRegistry();
registerBuiltinTypes(registry);
const store = new DocStore(registry, {
  meta: { title: rootName ?? root.text, updatedAt: new Date().toISOString() },
  tree: root,
});
store.updateNode(store.root.id, { text: rootName ?? root.text });

writeFileSync(outPath, JSON.stringify(store.toJSON(), null, 2), 'utf8');
console.log(
  `OK: ${stats.sections} 个模块, ${stats.cases} 条用例 → ${outPath}` +
    (stats.warnings.length
      ? `\n警告 ${stats.warnings.length} 条（前 10）:\n` + stats.warnings.slice(0, 10).join('\n')
      : ''),
);
