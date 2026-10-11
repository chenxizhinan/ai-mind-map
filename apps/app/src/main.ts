/**
 * ai-mind-map 主应用。
 *
 * 数据流：DocState（不可变引用）→ layoutTree → renderer.setData。
 * 交互：选择/折叠/拖放/右键/键盘（Tab/Enter/Del/方向键/F2/⌘Z/⌘C/⌘V），
 * 撤销重做基于 JSON 快照，localStorage 自动持久化。
 */
import {
  DocStore,
  NodeTypeRegistry,
  layoutTree,
  registerBuiltinTypes,
  decodeXmind,
  encodeXmind,
  encodeMarkdown,
  decodeMarkdown,
  type BaseNode,
  type FlatNode,
  type MindNode,
} from '@ai-mind-map/core';
import { MindRenderer } from '@ai-mind-map/renderer';
import type { MindDocument } from '@ai-mind-map/core';

const registry = new NodeTypeRegistry();
registerBuiltinTypes(registry);

// ---------- 演示数据（仅首次启动生成） ----------
function makeDemo(): MindDocument {
  const s = new DocStore(registry, {
    meta: { title: '订单中心 · 回归测试', updatedAt: new Date().toISOString() },
  });
  const modules = ['创建订单', '支付', '退款', '发货', '售后', '优惠券', '库存', '物流', '发票', '地址'];
  const prios = ['P0', 'P1', 'P2', 'P3'] as const;
    for (let i = 0; i < 120; i++) {
    const mod = modules[i % modules.length];
    s.addSubtree(s.root.id, {
      type: 'folder',
      text: `${mod}-${String(i).padStart(3, '0')}`,
      children: Array.from({ length: 100 }, (_, j) => ({
        type: 'case',
        text: `${mod}场景${j + 1}：测试场景模板`,
        props: { priority: prios[j % 4] },
      })),
    });
  }
  return s.toJSON();
}

function blankDoc(title = '新导图'): MindDocument {
  const s = new DocStore(registry, {
    meta: { title, updatedAt: new Date().toISOString() },
  });
  return s.toJSON();
}

// ---------- 持久化 ----------
const LS_KEY = 'ai-mind-map:doc';
const LS_EXPANDED = 'ai-mind-map:expanded';

function saveLocal(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(doc));
    localStorage.setItem(LS_EXPANDED, JSON.stringify([...(expandedIds ?? [])]));
  } catch {
    /* 存储满/禁用时静默 */
  }
}

function loadLocal(): MindDocument | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------- 状态 ----------
let doc: MindDocument;
let store: DocStore;
let selected: FlatNode | null = null;
let panelTab: 'info' | 'anns' = 'info';
let expandedIds: Set<string> | null = null;
let clipboard: string | null = null;
let editingId = false;

/** 当前编辑节点 id（编辑中禁用快捷键/撤销） */
let editingNodeId: string | null = null;

// ---------- 历史栈（撤销/重做） ----------
const MAX_HISTORY = 100;
let history: string[] = [];
let future: string[] = [];
let suppress = false;

/** 在 mutation 之前调用，保存变更前状态 */
function snapshot(): void {
  if (suppress || !store) return;
  history.push(JSON.stringify(store.toJSON()));
  if (history.length > MAX_HISTORY) history.shift();
  future = [];
}

function undo(): void {
  if (!history.length || editingNodeId) return;
  suppress = true;
  future.push(JSON.stringify(store.toJSON()));
  const snap = history.pop()!;
  loadDoc(JSON.parse(snap), true);
  suppress = false;
}

function redo(): void {
  if (!future.length || editingNodeId) return;
  suppress = true;
  history.push(JSON.stringify(store.toJSON()));
  const snap = future.pop()!;
  loadDoc(JSON.parse(snap), true);
  suppress = false;
}

// ---------- 渲染管线 ----------
const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new MindRenderer(canvasEl, {
  onSelect: (n) => {
    selected = n;
    renderPanel();
  },
  onToggleCollapse: (n) => toggleCollapse(n.id),
  onDrop: (node, target) => moveNode(node.id, target?.id ?? null),
  onContextMenu: (node, screen) => showCtxMenu(node, screen),
  onActivate: (n) => startEdit(n.id),
});
void renderer;

/** 布局 + 渲染 + 统计 + 持久化。selected 传 id 保持选中跨布局。 */
function relayout(): void {
  const flat = layoutTree(store.root, registry, {
    defaultExpandDepth: 2,
    expandedIds: expandedIds ?? undefined,
  });
  lastFlat = flat;
  const counts = new Map<string, number>();
  for (const a of store.document.annotations) {
    if (a.status !== 'open') continue;
    counts.set(a.nodeId, (counts.get(a.nodeId) ?? 0) + 1);
  }
  renderer.setData(flat, counts);
  document.getElementById('stats')!.textContent =
    `${countNodes(store.root).toLocaleString()} 节点 · ${store.document.annotations.filter((a) => a.status === 'open').length} 未解决批注`;
  const selId = selected?.id;
  if (selId) {
    selected = flat.find((n) => n.id === selId) ?? null;
    renderer.select(selected?.id ?? null);
  }
  saveLocal();
}

let lastFlat: FlatNode[] = [];

// ---------- 树操作（快照 → 变更 → relayout） ----------
function countNodes(n: MindNode): number {
  return 1 + (n.children ?? []).reduce((acc, c) => acc + countNodes(c), 0);
}

function toggleCollapse(id: string): void {
  if (!expandedIds) {
    expandedIds = new Set();
    const walk = (n: MindNode, d: number): void => {
      if (d < 2) {
        expandedIds!.add(n.id);
        for (const c of n.children ?? []) walk(c, d + 1);
      }
    };
    walk(store.root, 0);
  }
  if (expandedIds.has(id)) expandedIds.delete(id);
  else expandedIds.add(id);
  relayout();
}

function addChild(parentId: string, type = 'case', text = '新用例'): void {
  snapshot();
  const r = store.addSubtree(parentId, { type, text, props: type === 'case' ? { priority: 'P2' } : {} });
  relayout();
  renderer.focusNode(r.nodeId);
  selectId(r.nodeId);
}

function addSibling(id: string): void {
  const node = store.getNode(id);
  const parent = store.getParent(id);
  if (!node || !parent) return;
  addChild(parent.id, node.type, node.type === 'case' ? '新用例' : '新路径');
}

function deleteNode(id: string): void {
  if (id === store.root.id) {
    alert('根节点不能删除');
    return;
  }
  snapshot();
  store.deleteSubtree(id);
  if (selected?.id === id) selected = null;
  relayout();
}

function moveNode(id: string, targetId: string | null): void {
  if (!targetId) return;
  const node = store.getNode(id);
  const target = store.getNode(targetId);
  if (!node || !target) return;
  if (id === targetId) return;
  // 不能挂到自身或自身子树
  let up: MindNode | undefined = target;
  while (up) {
    if (up.id === id) {
      alert('不能移动到自身或自己的后代之下');
      return;
    }
    up = store.getParent(up.id);
  }
  if (registry.get(target.type).leafOnly) {
    alert('用例节点不能再添加子节点');
    return;
  }
  snapshot();
  store.moveSubtree(id, targetId);
  relayout();
  renderer.focusNode(id);
}

function startEdit(id: string): void {
  const node = store.getNode(id);
  if (!node) return;
  const f = lastFlat.find((n) => n.id === id);
  if (!f) return;
  editingNodeId = id;
  const ed = editorEl();
  const r = renderer.nodeScreenRect(f);
  ed.style.display = 'block';
  ed.style.left = `${r.left}px`;
  ed.style.top = `${r.top}px`;
  ed.style.width = `${Math.max(140, r.width)}px`;
  ed.style.height = `${r.height}px`;
  ed.textContent = node.text;
  ed.focus();
  document.getSelection()?.selectAllChildren(ed);
}

function commitEdit(): void {
  if (!editingNodeId) return;
  const ed = editorEl();
  const text = ed.textContent?.trim();
  const id = editingNodeId;
  editingNodeId = null;
  ed.style.display = 'none';
  if (text && text !== store.getNode(id)?.text) {
    snapshot();
    store.updateNode(id, { text });
    relayout();
  }
}

function editorEl(): HTMLDivElement {
  return document.getElementById('node-editor') as HTMLDivElement;
}

function selectId(id: string): void {
  selected = lastFlat.find((n) => n.id === id) ?? null;
  renderer.select(id);
  renderPanel();
}

// ---------- 键盘操作 ----------
window.addEventListener('keydown', (e) => {
  const tag = (document.activeElement as HTMLElement)?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement === editorEl();
  if (typing) return;

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (editingNodeId) return;

  const selId = selected?.id;
  if (!selId) return;

  if (e.key === 'Tab' || e.key === 'Insert') {
    e.preventDefault();
    if (store.getNode(selId)!.type === 'case') addSibling(selId);
    else addChild(selId, 'case', '新用例');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    addSibling(selId);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    navigateLR(e.key === 'ArrowLeft' ? 'in' : 'out');
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateUD(e.key === 'ArrowUp' ? -1 : 1);
  } else if (e.key === 'F2') {
    e.preventDefault();
    startEdit(selId);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteNode(selId);
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
    clipboard = JSON.stringify(store.getNode(selId));
    e.preventDefault();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    if (!clipboard) return;
    const node = store.getNode(selId)!;
    if (registry.get(node.type).leafOnly) {
      alert('用例节点不能再添加子节点');
      return;
    }
    snapshot();
    const clone = JSON.parse(clipboard);
    const r = store.addSubtree(selId, clone);
    relayout();
    renderer.focusNode(r.nodeId);
  } else if (e.key === ' ') {
    e.preventDefault();
    toggleCollapse(selId);
  }
});

// ---------- 导航 ----------
function navigateLR(dir: 'in' | 'out'): void {
  const id = selected?.id;
  if (!id) return;
  const cur = store.getNode(id)!;
  const kids = cur.children ?? [];
  if (dir === 'in') {
    if (kids.length) selectId(kids[0].id);
  } else {
    const p = store.getParent(id);
    if (p && p.id !== store.root.id) selectId(p.id);
  }
}

function navigateUD(delta: number): void {
  const id = selected?.id;
  if (!id) return;
  const p = store.getParent(id);
  if (!p) return;
  const siblings = p.children ?? [];
  const idx = siblings.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const next = (idx + delta + siblings.length) % siblings.length;
  selectId(siblings[next]!.id);
}

// ---------- 右键菜单 ----------
const ctxMenuEl = document.getElementById('ctx-menu') as HTMLDivElement;

function showCtxMenu(node: FlatNode, screen: { x: number; y: number }): void {
  const isRoot = node.depth === 0;
  const items: Array<{ label: string; kbd?: string; action?: () => void; danger?: boolean; divider?: boolean }> = [
    { label: '新建子节点', kbd: 'Tab', action: () => (store.getNode(node.id)!.type === 'case' ? addSibling(node.id) : addChild(node.id)) },
    { label: '新建同级节点', kbd: 'Enter', action: () => addSibling(node.id), },
    { label: '编辑文本', kbd: 'F2', action: () => startEdit(node.id) },
    { label: '展开/折叠', kbd: 'Space', action: () => toggleCollapse(node.id), divider: true },
    { label: '复制子树', kbd: '⌘C', action: () => { clipboard = JSON.stringify(store.getNode(node.id)); } },
    { label: '粘贴子树', kbd: '⌘V', action: () => pasteUnder(node.id) },
    { label: '转为路径节点', action: () => convertType(node.id, 'folder'), divider: true },
    { label: '转为用例节点', action: () => convertType(node.id, 'case') },
    { label: '删除子树', kbd: 'Del', action: () => deleteNode(node.id), danger: !isRoot },
  ];
  ctxMenuEl.innerHTML = items
    .map((it, i) =>
      it.divider
        ? '<div class="divider"></div>'
        : `<div class="item${it.danger ? ' danger' : ''}" data-idx="${i}">${escapeHtml(it.label)}${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}</div>`,
    )
    .join('');
  ctxMenuEl.style.display = 'block';
  ctxMenuEl.style.left = `${screen.x}px`;
  ctxMenuEl.style.top = `${screen.y}px`;
  ctxMenuEl.querySelectorAll('.item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number((el as HTMLElement).dataset.idx);
      items[idx]?.action?.();
      hideCtxMenu();
    });
  });
}

function hideCtxMenu(): void {
  ctxMenuEl.style.display = 'none';
}

window.addEventListener('pointerdown', (e) => {
  if (!ctxMenuEl.contains(e.target as Node)) hideCtxMenu();
});

function pasteUnder(parentId: string): void {
  if (!clipboard) return;
  const node = store.getNode(parentId);
  if (!node) return;
  if (registry.get(node.type).leafOnly) {
    alert('用例节点不能再添加子节点');
    return;
  }
  snapshot();
  const clone = JSON.parse(clipboard);
  const r = store.addSubtree(parentId, clone);
  relayout();
  renderer.focusNode(r.nodeId);
}

function convertType(id: string, newType: string): void {
  try {
    snapshot();
    store.setNodeType(id, newType);
    relayout();
    renderPanel();
  } catch (e) {
    alert((e as Error).message);
  }
}

// ---------- 侧边面板 ----------
const aside = document.getElementById('panel') as HTMLElement;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
function nodePathOf(n: MindNode): string {
  const parts: string[] = [];
  let cur: MindNode | undefined = n;
  while (cur) {
    parts.unshift(cur.text);
    cur = store.getParent(cur.id);
  }
  return parts.map(escapeHtml).join(' / ');
}

function renderPanel(): void {
  if (!selected) {
    aside.innerHTML = '<div style="margin:auto;color:#94a3b8;font-size:13px;text-align:center">选中节点查看详情</div>';
    return;
  }
  const node = store.getNode(selected.id);
  if (!node) return;
  const openCount = store.listAnnotations(node.id).filter((a) => a.status === 'open').length;
  const typeLabel = registry.has(node.type) ? registry.get(node.type).label : node.type;
  aside.innerHTML = `
    <div class="panel-head">
      <div class="node-path">${nodePathOf(node)}</div>
      <div class="node-title">${escapeHtml(node.text)}</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:3px">${typeLabel} · ${node.id}</div>
    </div>
    <div class="tabs">
      <div class="tab ${panelTab === 'info' ? 'active' : ''}" data-tab="info">用例信息</div>
      <div class="tab ${panelTab === 'anns' ? 'active' : ''}" data-tab="anns">批注${openCount ? `<span class="badge-count">${openCount}</span>` : ''}</div>
    </div>
    <div class="panel-body" id="panel-body"></div>
  `;
  aside.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      panelTab = (t as HTMLElement).dataset.tab as 'info' | 'anns';
      renderPanel();
    }),
  );
  const body = document.getElementById('panel-body')!;
  if (panelTab === 'info') renderInfoForm(body, node);
  else renderAnnotations(body, node);
}

function renderInfoForm(body: HTMLElement, node: MindNode): void {
  const isCase = node.type === 'case';
  if (isCase) {
    const p = node.props as { priority?: string; precondition?: string; steps?: string[]; expected?: string };
    body.innerHTML = `
      <div class="field">
        <label>优先级</label>
        <select id="f-priority">
          <option value="">未设置</option>
          ${['P0', 'P1', 'P2', 'P3'].map((x) => `<option ${p.priority === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>前置条件</label>
        <textarea id="f-precondition">${escapeHtml(p.precondition ?? '')}</textarea>
      </div>
      <div class="field">
        <label>测试步骤</label>
        <div id="steps-list">
          ${(p.steps ?? []).map((s) => `<textarea data-step>${escapeHtml(s)}</textarea>`).join('')}
        </div>
        <div class="btn-row"><button class="btn" id="btn-add-step">+ 步骤</button></div>
      </div>
      <div class="field">
        <label>预期结果</label>
        <textarea id="f-expected">${escapeHtml(p.expected ?? '')}</textarea>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="btn-save-case">保存</button>
      </div>
    `;
    document.getElementById('btn-add-step')?.addEventListener('click', () => {
      const ta = document.createElement('textarea');
      ta.setAttribute('data-step', '');
      document.getElementById('steps-list')!.appendChild(ta);
    });
    document.getElementById('btn-save-case')?.addEventListener('click', () => {
      const steps = [...body.querySelectorAll('textarea[data-step]')]
        .map((t) => (t as HTMLTextAreaElement).value.trim())
        .filter(Boolean);
      const priority = (document.getElementById('f-priority') as HTMLSelectElement).value;
      snapshot();
      store.updateNode(node.id, {
        props: {
          priority: priority || undefined,
          precondition: (document.getElementById('f-precondition') as HTMLTextAreaElement).value.trim() || undefined,
          steps: steps.length ? steps : undefined,
          expected: (document.getElementById('f-expected') as HTMLTextAreaElement).value.trim() || undefined,
        },
      });
      relayout();
    });
  } else {
    const note = String((node.props as { note?: string }).note ?? '');
    body.innerHTML = `
      <div class="field">
        <label>备注</label>
        <textarea id="f-note">${escapeHtml(note)}</textarea>
      </div>
      <div class="btn-row"><button class="btn primary" id="btn-save-folder">保存</button></div>
      <div class="field" style="margin-top:18px">
        <label>添加子节点</label>
        <div class="btn-row">
          <button class="btn" id="pa-add-folder">+ 子路径</button>
          <button class="btn" id="pa-add-case">+ 用例</button>
        </div>
      </div>
    `;
    document.getElementById('btn-save-folder')?.addEventListener('click', () => {
      snapshot();
      store.updateNode(node.id, {
        props: { note: (document.getElementById('f-note') as HTMLTextAreaElement).value.trim() || undefined },
      });
      relayout();
    });
    document.getElementById('pa-add-folder')?.addEventListener('click', () => {
      snapshot();
      store.addSubtree(node.id, { type: 'folder', text: '新路径' });
      relayout();
    });
    document.getElementById('pa-add-case')?.addEventListener('click', () => {
      snapshot();
      store.addSubtree(node.id, { type: 'case', text: '新用例', props: { priority: 'P2' } });
      relayout();
    });
  }
}

function renderAnnotations(body: HTMLElement, node: MindNode): void {
  const anns = store.listAnnotations(node.id);
  body.innerHTML =
    (anns.length ? anns.map(threadHtml).join('') : '<div style="color:#94a3b8;font-size:12px">该节点暂无批注</div>') +
    `
    <div class="field">
      <label>添加批注</label>
      <textarea id="new-ann" placeholder="评审意见、边界提醒…"></textarea>
    </div>
    <button class="btn primary" id="btn-new-ann">添加批注</button>
  `;
  document.getElementById('btn-new-ann')?.addEventListener('click', () => {
    const ta = document.getElementById('new-ann') as HTMLTextAreaElement;
    if (!ta.value.trim()) return;
    snapshot();
    store.addAnnotation(node.id, ta.value.trim(), 'user');
    relayout();
    renderPanel();
  });
  body.querySelectorAll('[data-resolved]').forEach((btn) =>
    btn.addEventListener('click', () => {
      snapshot();
      store.setAnnotationStatus((btn as HTMLElement).dataset.resolved!, 'resolved');
      relayout();
      renderPanel();
    }),
  );
  body.querySelectorAll('[data-reply-btn]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.replyBtn!;
      const box = body.querySelector(`[data-reply-box="${id}"] textarea`) as HTMLTextAreaElement | null;
      if (box?.value.trim()) {
        snapshot();
        store.replyAnnotation(id, box.value.trim(), 'user');
        relayout();
        renderPanel();
      }
    }),
  );
}

function threadHtml(a: {
  id: string;
  createdBy: string;
  createdAt: string;
  body: string;
  status: string;
  replies: Array<{ createdBy: string; createdAt: string; body: string }>;
}): string {
  const who = (by: string) => `<span class="who ${by === 'ai' ? 'ai' : ''}">${by === 'ai' ? 'Claude' : '我'}</span>`;
  return `
  <div class="thread">
    <div class="meta">${who(a.createdBy)} · ${fmtTime(a.createdAt)}
      <span class="status-chip ${a.status}">${a.status === 'open' ? '未解决' : '已解决'}</span>
    </div>
    <div class="body">${escapeHtml(a.body)}</div>
    ${a.replies
      .map(
        (r) =>
          `<div class="reply"><div class="meta">${who(r.createdBy)} · ${fmtTime(r.createdAt)}</div><div class="body">${escapeHtml(r.body)}</div></div>`,
      )
      .join('')}
    <div class="reply-box" data-reply-box="${a.id}"><textarea placeholder="回复…"></textarea></div>
    <div class="actions">
      ${a.status === 'open' ? `<button class="btn" data-resolved="${a.id}">标记解决</button>` : ''}
      <button class="btn" data-reply-btn="${a.id}">回复</button>
    </div>
  </div>`;
}

// ---------- 导入/导出 ----------
function download(filename: string, data: BlobPart, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('import-xmind')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xmind';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => {
      try {
        const { tree, warnings } = decodeXmind(new Uint8Array(buf), registry);
        loadDoc({
          version: 1,
          meta: { title: tree.text, updatedAt: new Date().toISOString() },
          tree,
          annotations: [],
        });
        if (warnings.length) alert(`导入完成，${warnings.length} 条警告：\n${warnings.slice(0, 5).join('\n')}`);
      } catch (e) {
        alert(`导入失败：${(e as Error).message}`);
      }
    });
  };
  input.click();
});

document.getElementById('export-xmind')?.addEventListener('click', () => {
  try {
    const bytes = encodeXmind(store.root, store.document.meta.title);
    download(`${store.document.meta.title || 'mindmap'}.xmind`, bytes.slice().buffer, 'application/octet-stream');
  } catch (e) {
    alert(`导出失败：${(e as Error).message}`);
  }
});

document.getElementById('export-md')?.addEventListener('click', () => {
  try {
    const md = encodeMarkdown(store.root);
    download(`${store.document.meta.title || 'mindmap'}.md`, md, 'text/markdown');
  } catch (e) {
    alert(`导出失败：${(e as Error).message}`);
  }
});

// ---------- 工具条 ----------
document.getElementById('btn-undo')?.addEventListener('click', undo);
document.getElementById('btn-redo')?.addEventListener('click', redo);
document.getElementById('btn-expand-all')?.addEventListener('click', () => {
  const all = new Set<string>();
  const walk = (n: MindNode): void => {
    if (n.children?.length) {
      all.add(n.id);
      for (const c of n.children) walk(c);
    }
  };
  walk(store.root);
  expandedIds = all.size ? all : null;
  relayout();
  renderer.focusNode(store.root.id);
});
document.getElementById('btn-collapse-all')?.addEventListener('click', () => {
  expandedIds = new Set([store.root.id]);
  relayout();
  renderer.focusNode(store.root.id);
});
document.getElementById('btn-add-case')?.addEventListener('click', () => {
  if (!selected) {
    alert('先选中一个路径节点');
    return;
  }
  const node = store.getNode(selected.id)!;
  if (node.type === 'case') {
    addSibling(selected.id);
  } else {
    addChild(selected.id);
  }
});

// 缩放工具条
document.getElementById('zoom-in')?.addEventListener('click', () => {
  const vp = renderer.viewport;
  const s = Math.min(8, vp.scale * 1.25);
  const applied = s / vp.scale;
  renderer.setViewport({
    scale: s,
    offsetX: (canvasEl.clientWidth / 2) * (1 - applied) + vp.offsetX * applied,
    offsetY: (canvasEl.clientHeight / 2) * (1 - applied) + vp.offsetY * applied,
  });
  updateZoomPct();
});
document.getElementById('zoom-out')?.addEventListener('click', () => {
  const vp = renderer.viewport;
  const s = Math.max(0.05, vp.scale / 1.25);
  const applied = s / vp.scale;
  renderer.setViewport({
    scale: s,
    offsetX: (canvasEl.clientWidth / 2) * (1 - applied) + vp.offsetX * applied,
    offsetY: (canvasEl.clientHeight / 2) * (1 - applied) + vp.offsetY * applied,
  });
  updateZoomPct();
});
document.getElementById('zoom-fit')?.addEventListener('click', fitView);
function updateZoomPct(): void {
  const el = document.getElementById('zoom-pct');
  if (el) el.textContent = `${Math.round(renderer.viewport.scale * 100)}%`;
}
renderer.setData([], new Map()); // 初始化帧循环

/** 适应全图：计算所有 flat 的包围盒，缩放平移至完全可见 */
function fitView(): void {
  if (!lastFlat.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of lastFlat) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w);
    y1 = Math.max(y1, n.y + n.h);
  }
  const pad = 60;
  const w = x1 - x0 + pad * 2;
  const h = y1 - y0 + pad * 2;
  const scale = Math.min(8, Math.max(0.05, Math.min(canvasEl.clientWidth / w, canvasEl.clientHeight / h)));
  renderer.setViewport({
    scale,
    offsetX: canvasEl.clientWidth / 2 - (x0 + (x1 - x0) / 2) * scale,
    offsetY: canvasEl.clientHeight / 2 - (y0 + (y1 - y0) / 2) * scale,
  });
  updateZoomPct();
}

// ---------- 文档装载 ----------
function loadDoc(d: MindDocument, keepViewport = false): void {
  doc = d;
  store = DocStore.fromJSON(registry, d);
  expandedIds = null;
  selected = null;
  renderPanel();
  relayout();
  if (!keepViewport) renderer.focusNode(store.root.id);
}

// 编辑器失焦提交
editorEl().addEventListener('blur', commitEdit);
editorEl().addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    editingNodeId = null;
    editorEl().style.display = 'none';
  }
});
// 手动 commitEdit 绑定后 reattach：blur 触发在 display:none 之前调用

// ---------- 启动 ----------
const stored = loadLocal();
if (stored) {
  try {
    loadDoc(stored, false);
    const rawExp = localStorage.getItem(LS_EXPANDED);
    if (rawExp) {
      const arr = JSON.parse(rawExp) as string[];
      expandedIds = arr.length ? new Set(arr) : null;
      relayout();
    }
  } catch {
    loadDoc(makeDemo(), false);
  }
} else {
  loadDoc(makeDemo(), false);
}
updateZoomPct();

// 暴露给自动化测试 / 控制台调试
(window as unknown as Record<string, unknown>).renderer = renderer;
(window as unknown as Record<string, unknown>).store = () => store;
(window as unknown as Record<string, unknown>).appState = () => ({ selected, expandedIds });
