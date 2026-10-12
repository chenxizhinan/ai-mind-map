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
import { MindRenderer, builtinThemeRefs } from '@ai-mind-map/renderer';

const THEME_KEY = 'ai-mind-map:theme';

function applyTheme(name: string): void {
  const t = builtinThemeRefs[name];
  if (t) renderer.setTheme(t.theme);
  localStorage.setItem(THEME_KEY, name);
}
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
const LS_KEY = 'ai-mind-map:doc';        // 旧版单文档键（仅迁移用）
const LS_EXPANDED = 'ai-mind-map:expanded'; // 旧版键（仅迁移读）

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖写入：折叠/拖动等连续操作时不逐次序列化大文档。
 * 多文档模式：写入当前文档槽位（persistCurrent），并按文档保存展开状态。
 */
function saveLocal(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistCurrent();
    if (currentDocId) {
      try {
        localStorage.setItem(LS_EXPANDED + ':' + currentDocId, JSON.stringify([...(expandedIds ?? [])]));
      } catch {
        /* 存储满：静默 */
      }
    }
    void pushRemote(); // 桥接在线时同步给远端（内部静默失败）
  }, 800);
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
  onMultiSelect: (ids) => {
    showBatchBar(ids);
  },
  onToggleCollapse: (n) => toggleCollapse(n.id),
  onDrop: (node, target, position) => dropNode(node.id, target, position),
  isLeafNode: (id) => isLeafNode(id),
  isContainerNode: (id) => {
    const n = store.getNode(id);
    return !!n && registry.get(n.type).role === 'container';
  },
  onContextMenu: (node, screen) => showCtxMenu(node, screen),
  onActivate: (n) => startEdit(n.id),
});
void renderer;

// ---------- 布局方向 ----------
type LayoutDir = 'right' | 'both' | 'down' | 'up';
const LAYOUT_KEY = 'ai-mind-map:layout';
const LAYOUT_LABELS: Record<LayoutDir, string> = {
  both: '地图（左右）',
  right: '逻辑图（向右）',
  down: '组织结构（向下）',
  up: '向上树',
};
let layoutDir = (localStorage.getItem(LAYOUT_KEY) as LayoutDir) || 'both';

/** 布局 + 渲染 + 统计 + 持久化。selected 传 id 保持选中跨布局。 */
function relayout(): void {
  const flat = layoutTree(store.root, registry, {
    defaultExpandDepth: 2,
    expandedIds: expandedIds ?? undefined,
    direction: layoutDir,
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

function addChild(parentId: string, type = 'case', text = '新用例', edit = true): void {
  snapshot();
  const r = store.addSubtree(parentId, { type, text, props: type === 'case' ? { priority: 'P2' } : {} });
  relayout();
  renderer.focusNode(r.nodeId);
  selectId(r.nodeId);
  if (edit) startEdit(r.nodeId); // XMind 式：建完即编辑
}

/** 节点是否为叶子（leafOnly 类型，如测试用例）：不允许新建子节点 */
function isLeafNode(id: string): boolean {
  const n = store.getNode(id);
  return !!n && registry.get(n.type).leafOnly === true;
}

/** 智能新子节点类型：跟随父级语义（folder 下建 folder 路径层，深层叶子用例） */
function smartChildType(parentDepth: number): string {
  // 路径深度 1-2 层用 folder，更深默认用例叶子；根的直接子级一律 folder
  return parentDepth === 0 ? 'folder' : 'case';
}

function addSibling(id: string): void {
  const node = store.getNode(id);
  const parent = store.getParent(id);
  if (!node || !parent) return;
  addChild(parent.id, node.type, node.type === 'case' ? '新用例' : '新路径');
}

function deleteNode(id: string): void {
  if (id === store.root.id) {
    toast('根节点不能删除', 'warn');
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
      toast('不能移动到自身或自己的后代之下', 'warn');
      return;
    }
    up = store.getParent(up.id);
  }
  if (registry.get(target.type).leafOnly) {
    toast('用例节点不能再添加子节点', 'warn');
    return;
  }
  snapshot();
  store.moveSubtree(id, targetId);
  relayout();
  renderer.focusNode(id);
}

// ---------- 兄弟排序（顺序固化在文档 children 顺序里） ----------

/**
 * 在同级内移动节点位置。offset: -1=上移(前移) 1=下移(后移)；
 * 'first'=置顶 'last'=置底。根子级与普通层级都可用。
 * @returns 是否发生了移动
 */
function reorderSibling(id: string, offset: -1 | 1 | 'first' | 'last'): boolean {
  const node = store.getNode(id);
  const parent = store.getParent(id);
  if (!node || !parent) return false;
  const siblings = parent.children ?? [];
  const idx = siblings.findIndex((s) => s.id === id);
  if (idx === -1) return false;

  let target: number;
  if (offset === 'first') target = 0;
  else if (offset === 'last') target = siblings.length - 1;
  else target = idx + offset;

  if (target === idx || target < 0 || target >= siblings.length) return false;
  snapshot();
  // 同父移动：先移除自身，再按补偿索引插入。置顶=0；置底=删除后末尾；
  // 上移=删除后原 target 前移一位；下移=删除后原 idx+1 处即为目标位
  let insertAt: number;
  if (offset === 'first') insertAt = 0;
  else if (offset === 'last') insertAt = siblings.length - 1;
  else if (offset === -1) insertAt = Math.max(0, idx - 1);
  else insertAt = idx; // +1：删除自身后原 idx+1 处即为目标位
  store.moveSubtree(id, parent.id, insertAt);
  relayout();
  return true;
}

/**
 * 拖放落点：child=挂到 target 下；before/after=成为 target 的兄弟（插到其前/后）。
 */
function dropNode(id: string, target: FlatNode | null, position: 'child' | 'before' | 'after'): void {
  if (!target) return;
  const node = store.getNode(id);
  const t = store.getNode(target.id);
  if (!node || !t) return;
  if (id === target.id) return;
  // 防环
  let up: MindNode | undefined = t;
  while (up) {
    if (up.id === id) {
      toast('不能移动到自身或自己的后代之下', 'warn');
      return;
    }
    up = store.getParent(up.id);
  }
  snapshot();
  if (position === 'child') {
    if (registry.get(t.type).leafOnly) {
      toast('用例节点不能再添加子节点', 'warn');
      return;
    }
    store.moveSubtree(id, t.id);
  } else {
    // 成为兄弟：挂到 target 的父下，插到 target 前/后
    const p = store.getParent(target.id);
    if (!p) return;
    const sameParent = p.id === store.getParent(id)!.id;
    const idx = (p.children ?? []).findIndex((s) => s.id === target.id);
    // moveSubtree 先从旧位置移除再插入；同父时删除会使 target 及其索引左移一位
    const insertAt = sameParent
      ? (position === 'before' ? (idx > 0 ? idx - 1 : 0) : idx)
      : (position === 'before' ? idx : idx + 1);
    store.moveSubtree(id, p.id, insertAt);
  }
  relayout();
  renderer.focusNode(id);
}

/** 框选后的批量操作条 */
function showBatchBar(ids: string[]): void {
  const bar = document.getElementById('batch-bar') as HTMLElement;
  if (!ids.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.dataset.count = String(ids.length);
  (document.getElementById('batch-count') as HTMLElement).textContent = `已选 ${ids.length} 个节点`;
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchBox.style.display = 'flex';
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (editingNodeId) return;

  const selId = selected?.id;
  if (!selId) return;

  if (e.key === 'Tab' && e.shiftKey) {
    // ⇧Tab 反缩进：把节点提升到祖父之下（幕布行为）
    e.preventDefault();
    outdent(selId);
  } else if (e.key === 'Tab' || e.key === 'Insert') {
    e.preventDefault();
    // 叶子节点（leafOnly 类型）按 Tab 自动降级为新建同级
    if (isLeafNode(selId)) {
      addSibling(selId);
    } else {
      addChild(selId, smartChildType(depthOf(selId)));
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    addSibling(selId);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    smartNavigateLR(e.key === 'ArrowRight' ? 'in' : 'out');
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    // Alt+↑/↓：同级内上移/下移（顺序固化到文档 children 顺序）
    e.preventDefault();
    if (reorderSibling(selId, e.key === 'ArrowUp' ? -1 : 1)) {
      renderer.focusNode(selId);
    }
  } else if (e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    // ⌘/Ctrl+Alt+←/→：置顶/置底
    e.preventDefault();
    if (reorderSibling(selId, e.key === 'ArrowLeft' ? 'first' : 'last')) {
      renderer.focusNode(selId);
      toast(e.key === 'ArrowLeft' ? '已移到最前' : '已移到最后', 'success');
    }
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
      toast('用例节点不能再添加子节点', 'warn');
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
function depthOf(id: string): number {
  let d = 0;
  let cur = store.getParent(id);
  while (cur) {
    d++;
    cur = store.getParent(cur.id);
  }
  return d;
}

/** 智能左右键（XMind 行为）：折叠态先展开再进入子级；展开态直接进入；'out' 返回父级 */
function smartNavigateLR(dir: 'in' | 'out'): void {
  const id = selected?.id;
  if (!id) return;
  const cur = store.getNode(id)!;
  const kids = cur.children ?? [];
  if (dir === 'in') {
    if (kids.length === 0) return;
    if (expandedIds && !expandedIds.has(id)) {
      expandedIds!.add(id);
      relayout();
    }
    selectId(kids[0].id);
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

// ---------- 搜索定位（⌘F） ----------
const searchBox = document.getElementById('search-box') as HTMLDivElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchMeta = document.getElementById('search-meta') as HTMLElement;
let searchMatches: string[] = [];
let searchCursor = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function runSearch(): void {
  const q = searchInput.value.trim().toLowerCase();
  searchMatches = [];
  searchCursor = 0;
  if (!q) {
    searchMeta.textContent = '';
    renderer.setSearchHits(null);
    return;
  }
  for (const n of lastFlat) {
    if (n.text.toLowerCase().includes(q)) searchMatches.push(n.id);
  }
  searchMeta.textContent = searchMatches.length
    ? `${searchCursor + 1}/${searchMatches.length}`
    : '无结果';
  renderer.setSearchHits(new Set(searchMatches));
  if (searchMatches.length) focusSearchHit();
}

function focusSearchHit(): void {
  const id = searchMatches[searchCursor];
  if (!id) return;
  // 命中节点可能藏在折叠子树里：先展开祖先链
  ensureExpandedInit();
  let cur = store.getParent(id);
  while (cur) {
    expandedIds!.add(cur.id);
    cur = store.getParent(cur.id);
  }
  relayout();
  selectId(id);
  renderer.setSearchHits(searchMatches.length ? new Set(searchMatches) : null, id);
  renderer.focusNode(id);
}

function ensureExpandedInit(): void {
  if (expandedIds) return;
  expandedIds = new Set();
  const walk = (n: MindNode, d: number): void => {
    if (d < 2) {
      expandedIds!.add(n.id);
      for (const c of n.children ?? []) walk(c, d + 1);
    }
  };
  walk(store.root, 0);
}

searchInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!searchMatches.length) {
      runSearch();
      return;
    }
    searchCursor = (searchCursor + 1) % searchMatches.length;
    searchMeta.textContent = `${searchCursor + 1}/${searchMatches.length}`;
    focusSearchHit();
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});
function closeSearch(): void {
  searchBox.style.display = 'none';
  searchInput.value = '';
  searchMeta.textContent = '';
  searchMatches = [];
  renderer.setSearchHits(null);
  searchInput.blur();
}
document.getElementById('search-close')?.addEventListener('click', closeSearch);

// ---------- 右键菜单 ----------
const ctxMenuEl = document.getElementById('ctx-menu') as HTMLDivElement;

function showCtxMenu(node: FlatNode, screen: { x: number; y: number }): void {
  const isRoot = node.depth === 0;
  const leaf = isLeafNode(node.id);
  const items: Array<{ label: string; kbd?: string; action?: () => void; danger?: boolean; divider?: boolean; disabled?: boolean; disabledHint?: string }> = [
    {
      label: leaf ? '新建子节点（用例不可含子节点）' : '新建子节点',
      kbd: 'Tab',
      // 叶子节点按 Tab 自动降级为新建同级（XMind 行为）
      action: () => (leaf ? addSibling(node.id) : addChild(node.id, smartChildType(depthOf(node.id)))),
      disabled: leaf,
      disabledHint: leaf ? '按 Tab/Enter 将自动新建同级节点' : undefined,
    },
    { label: '新建同级节点', kbd: 'Enter', action: () => addSibling(node.id), },
    { label: '编辑文本', kbd: 'F2', action: () => startEdit(node.id) },
    { label: '设置节点样式…', action: () => showStylePanel(node.id) },
    { label: '展开/折叠', kbd: 'Space', action: () => toggleCollapse(node.id), divider: true },
    { label: '复制子树', kbd: '⌘C', action: () => { clipboard = JSON.stringify(store.getNode(node.id)); } },
    {
      label: '粘贴子树',
      kbd: '⌘V',
      action: () => pasteUnder(node.id),
      disabled: leaf,
      disabledHint: leaf ? '用例节点不允许粘贴子节点' : undefined,
    },
    { label: '转为路径节点', action: () => convertType(node.id, 'folder'), divider: true },
    { label: '转为用例节点', action: () => convertType(node.id, 'case') },
    {
      label: '上移',
      kbd: '⌥↑',
      action: () => {
        if (!reorderSibling(node.id, -1)) toast('已在最前', 'info');
      },
      divider: true,
    },
    {
      label: '下移',
      kbd: '⌥↓',
      action: () => {
        if (!reorderSibling(node.id, 1)) toast('已在最后', 'info');
      },
    },
    {
      label: '移到最前',
      kbd: '⌘⌥←',
      action: () => {
        if (!reorderSibling(node.id, 'first')) toast('已在最前', 'info');
      },
    },
    {
      label: '移到最后',
      kbd: '⌘⌥→',
      action: () => {
        if (!reorderSibling(node.id, 'last')) toast('已在最后', 'info');
      },
    },
    { label: '删除子树', kbd: 'Del', action: () => deleteNode(node.id), danger: !isRoot },
  ];
  ctxMenuEl.innerHTML = items
    .map((it, i) =>
      it.divider
        ? '<div class="divider"></div>'
        : `<div class="item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" data-idx="${i}" ${it.disabledHint ? `title="${escapeHtml(it.disabledHint)}"` : ''}>${escapeHtml(it.label)}${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}</div>`,
    )
    .join('');
  ctxMenuEl.style.display = 'block';
  ctxMenuEl.style.left = `${screen.x}px`;
  ctxMenuEl.style.top = `${screen.y}px`;
  ctxMenuEl.querySelectorAll('.item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.currentTarget as HTMLElement).classList.contains('disabled')) return;
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

function pasteUnder(parentId: string): void {  if (!clipboard) return;
  const node = store.getNode(parentId);
  if (!node) return;
  if (registry.get(node.type).leafOnly) {
    toast('用例节点不能再添加子节点', 'warn');
    return;
  }
  snapshot();
  const clone = JSON.parse(clipboard);
  const r = store.addSubtree(parentId, clone);
  relayout();
  renderer.focusNode(r.nodeId);
}

/** ⇧Tab 反缩进：把节点提升一级（挂到祖父之下，位置紧随原父节点） */
function outdent(id: string): void {
  const parent = store.getParent(id);
  if (!parent || parent.id === store.root.id) return; // 顶层/根子级不可再提
  const grandparent = store.getParent(parent.id);
  if (!grandparent) return;
  snapshot();
  // 在自身移除前取原父在祖父下的索引；moveSubtree 移除自身后插入即恰好落在原父之后
  const idx = (grandparent.children ?? []).findIndex((c) => c.id === parent.id);
  store.moveSubtree(id, grandparent.id, idx + 1);
  relayout();
  renderer.focusNode(id);
}

function convertType(id: string, newType: string): void {
  try {
    snapshot();
    store.setNodeType(id, newType);
    relayout();
    renderPanel();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------- 样式面板与批量操作 ----------
const PALETTE = ['#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#7c3aed', '#db2777', '#64748b', '#0f172a'];

// ---------- 通用 Toast ----------
const toastWrap = document.createElement('div');
toastWrap.id = 'toast-wrap';
toastWrap.style.cssText =
  'position:fixed;bottom:52px;left:50%;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none';
document.body.appendChild(toastWrap);

/**
 * 通用 toast 提示。type: info(默认)/success/warn/error，2.6s 自动消失。
 */
function toast(message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  const bg: Record<string, string> = {
    info: '#1e293b',
    success: '#15803d',
    warn: '#b45309',
    error: '#dc2626',
  };
  const c = bg[level] ?? bg.info!;
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = `max-width:70vw;padding:9px 16px;border-radius:9px;font-size:13px;line-height:1.5;color:#fff;background:${c};box-shadow:0 8px 30px rgba(15,23,42,0.25);opacity:0;transform:translateY(8px);transition:opacity 0.18s ease,transform 0.18s ease;white-space:pre-wrap`;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

/** 单节点样式面板（右键 → 设置节点样式：颜色 + 图标） */
const ICON_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: '无' },
  { value: 'dot', label: '●' },
  { value: 'square', label: '□' },
  { value: '▲', label: '▲' },
  { value: '★', label: '★' },
  { value: '◆', label: '◆' },
  { value: '⬤', label: '⬤' },
];

function showStylePanel(nodeId: string): void {
  const menu = ctxMenuEl;
  const node = store.getNode(nodeId);
  if (!node) return;
  const current = String((node.props as { color?: string }).color ?? '');
  const currentIcon = String((node.props as { icon?: string }).icon ?? '');
  const swatches = PALETTE.map(
    (c) =>
      `<div class="swatch" data-color="${c}" style="width:26px;height:26px;border-radius:7px;background:${c};cursor:pointer;${current === c ? 'outline:2px solid #1e293b;outline-offset:2px;' : ''}"></div>`,
  ).join('');
  const iconBtns = ICON_CHOICES.map(
    (ic) =>
      `<div class="icon-opt" data-icon="${escapeHtml(ic.value)}" title="${ic.label === '无' ? '不显示图标' : ic.label}" style="width:28px;height:28px;border-radius:7px;border:1px solid ${currentIcon === ic.value ? '#2563eb' : '#e2e8f0'};display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;color:#475569;${currentIcon === ic.value ? 'background:#eff6ff;' : ''}">${ic.label === '无' ? '<span style="font-size:11px;color:#94a3b8">无</span>' : escapeHtml(ic.label)}</div>`,
  ).join('');
  menu.innerHTML = `
    <div style="padding:10px 12px;max-width:240px">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;font-weight:600">颜色</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${swatches}
        ${current ? '<div class="swatch" data-color="" title="清除颜色" style="width:26px;height:26px;border-radius:7px;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;color:#94a3b8">✕</div>' : ''}
      </div>
      <div style="font-size:11px;color:#94a3b8;margin:10px 0 6px;font-weight:600">图标</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${iconBtns}</div>
    </div>
  `;
  menu.style.display = 'block';
  menu.querySelectorAll('.swatch').forEach((el) => {
    el.addEventListener('click', () => {
      const color = (el as HTMLElement).dataset.color || '';
      snapshot();
      store.updateNode(nodeId, { props: { color: color || undefined } });
      relayout();
      if (!color) showStylePanel(nodeId); // 清除后刷新面板，隐藏"✕ 清除"
      else hideCtxMenu();
    });
  });
  menu.querySelectorAll('.icon-btn, [data-icon]').forEach((el) => {
    el.addEventListener('click', () => {
      const icon = (el as HTMLElement).dataset.icon || '';
      snapshot();
      store.updateNode(nodeId, { props: { icon: icon || undefined } });
      relayout();
      hideCtxMenu();
      toast(icon ? '图标已设置' : '图标已清除', 'success');
    });
  });
}

/** 批量操作条事件绑定 */
document.getElementById('batch-delete')?.addEventListener('click', () => {
  const ids = renderer.multiSelectIds;
  if (!ids.length) return;
  snapshot();
  for (const id of ids) {
    if (id !== store.root.id && store.getNode(id)) store.deleteSubtree(id);
  }
  renderer.setMultiSelect([]);
  showBatchBar([]);
  relayout();
});
document.getElementById('batch-color')?.addEventListener('click', () => {
  const ids = renderer.multiSelectIds;
  if (!ids.length) return;
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)]!;
  snapshot();
  for (const id of ids) {
    const n = store.getNode(id);
    if (n) store.updateNode(id, { props: { color } });
  }
  relayout();
});
document.getElementById('batch-priority')?.addEventListener('click', () => {
  const ids = renderer.multiSelectIds;
  if (!ids.length) return;
  const order = ['P0', 'P1', 'P2', 'P3', ''] as const;
  // 轮转：P0→P1→P2→P3→未设置→P0
  const current = String((store.getNode(ids[0]!)?.props as { priority?: string })?.priority ?? '');
  const next = order[(order.indexOf(current as never) + 1) % order.length]!;
  snapshot();
  for (const id of ids) {
    store.updateNode(id, { props: { priority: next || undefined } });
  }
  relayout();
});
document.getElementById('batch-cancel')?.addEventListener('click', () => {
  renderer.setMultiSelect([]);
  showBatchBar([]);
});

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
  const typeIcon = registry.has(node.type) ? registry.get(node.type).icon : undefined;
  const iconHtml =
    typeIcon === 'dot'
      ? '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2563eb;margin-right:6px"></span>'
      : typeIcon === 'square'
        ? '<span style="display:inline-block;width:10px;height:10px;border:1.5px solid #94a3b8;border-radius:2px;margin-right:6px"></span>'
        : typeIcon
          ? `<span style="margin-right:4px">${typeIcon}</span>`
          : '';
  aside.innerHTML = `
    <div class="panel-head">
      <div class="node-path">${nodePathOf(node)}</div>
      <div class="node-title" style="display:flex;align-items:center">${iconHtml}${escapeHtml(node.text)}</div>
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
  const isCase = node.type === 'case'; // 内置用例类型显示专有表单；其他类型走通用表单
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
    const leaf = registry.get(node.type).leafOnly === true;
    body.innerHTML = `
      <div class="field">
        <label>备注</label>
        <textarea id="f-note">${escapeHtml(note)}</textarea>
      </div>
      <div class="btn-row"><button class="btn primary" id="btn-save-folder">保存</button></div>
      ${
        leaf
          ? `<div style="margin-top:18px;font-size:12px;color:#94a3b8">用例（叶子节点）不允许添加子节点。如需挂子内容，先右键「转为路径节点」。</div>`
          : `<div class="field" style="margin-top:18px">
        <label>添加子节点</label>
        <div class="btn-row">
          <button class="btn" id="pa-add-folder">+ 子路径</button>
          <button class="btn" id="pa-add-case">+ 用例</button>
        </div>
      </div>`
      }
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

// ---------- 大纲视图（幕布式） ----------
const outlinePane = document.getElementById('outline-pane') as HTMLDivElement;
const viewToggleBtn = document.getElementById('view-toggle') as HTMLButtonElement;
let outlineMode = false;
let outlineCollapsed = new Set<string>();

function outlineHtml(): string {
  const render = (n: MindNode, depth: number): string => {
    const kids = n.children ?? [];
    const collapsed = outlineCollapsed.has(n.id);
    const priority = (n.props as { priority?: string }).priority;
    const icon = registry.has(n.type) ? registry.get(n.type).icon : undefined;
    const toggle = kids.length
      ? `<span class="o-toggle" data-toggle="${n.id}" style="cursor:pointer;display:inline-block;width:16px;text-align:center;color:#94a3b8;font-size:11px;user-select:none">${collapsed ? '▸' : '▾'}</span>`
      : '<span style="display:inline-block;width:16px"></span>';
    const iconSpan = icon
      ? icon === 'dot'
        ? `<span class="o-icon" title="${escapeHtml(typeLabelOf(n.type))}" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#2563eb;margin-left:4px;flex-shrink:0;align-self:center"></span>`
        : icon === 'square'
          ? `<span class="o-icon" title="${escapeHtml(typeLabelOf(n.type))}" style="display:inline-block;width:9px;height:9px;border:1.5px solid #94a3b8;border-radius:2px;margin-left:4px;flex-shrink:0;align-self:center"></span>`
          : `<span class="o-icon" title="${escapeHtml(typeLabelOf(n.type))}" style="font-size:12px;user-select:none;margin-left:2px">${icon}</span>`
      : '';
    const badge = priority && depth > 0 ? `<span class="o-badge" style="font-size:10px;background:#e2e8f0;border-radius:4px;padding:1px 5px;margin-left:6px;color:#475569">${escapeHtml(priority)}</span>` : '';
    return `
      <div class="o-row" data-node="${n.id}" style="margin-left:${depth * 22}px;display:flex;align-items:baseline;gap:2px;padding:3px 6px;border-radius:6px">
        ${toggle}${iconSpan}${badge}
        <span class="o-text" contenteditable="plaintext-only" data-otext="${n.id}" style="flex:1;outline:none;border-radius:4px;padding:2px 6px">${escapeHtml(n.text)}</span>
        <span style="font-size:10px;color:#cbd5e1;user-select:none">${kids.length ? `${kids.length}` : ''}</span</span>
      </div>
      ${!collapsed && kids.length ? kids.map((k) => render(k, depth + 1)).join('') : ''}
    `;
  };
  return render(store.root, 0);
}

/** 类型展示名（未注册类型回退为其 name） */
function typeLabelOf(type: string): string {
  return registry.has(type) ? registry.get(type).label : type;
}

function renderOutline(): void {
  outlinePane.innerHTML = outlineHtml();
}

function toggleOutline(): void {
  outlineMode = !outlineMode;
  viewToggleBtn.textContent = outlineMode ? '画布视图' : '大纲视图';
  outlinePane.style.display = outlineMode ? 'block' : 'none';
  if (outlineMode) renderOutline();
}

viewToggleBtn.addEventListener('click', toggleOutline);

// 大纲内编辑：失焦提交文本
outlinePane.addEventListener('focusout', (e) => {
  const span = (e.target as HTMLElement).closest('[data-otext]') as HTMLElement | null;
  if (!span) return;
  const id = span.dataset.otext!;
  const node = store.getNode(id);
  const next = span.textContent?.trim() ?? '';
  if (node && next && next !== node.text) {
    snapshot();
    store.updateNode(id, { text: next });
    relayout();
  } else if (node && !next) {
    span.textContent = node.text; // 空文本回滚
  }
});

// 折叠切换
outlinePane.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-toggle]') as HTMLElement | null;
  if (!t) return;
  const id = t.dataset.toggle!;
  if (outlineCollapsed.has(id)) outlineCollapsed.delete(id);
  else outlineCollapsed.add(id);
  renderOutline();
});

// ---------- 导入/导出菜单 ----------
function download(filename: string, data: BlobPart, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 从本地选一个文件读入（accept 传 MIME/扩展名过滤器） */
function pickFile(accept: string, onload: (buf: ArrayBuffer) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    f.arrayBuffer().then(onload);
  };
  input.click();
}

const ioMenuEl = document.getElementById('io-menu') as HTMLDivElement;
const ioToggleBtn = document.getElementById('io-toggle') as HTMLButtonElement;

/** 菜单锚定到按钮下方，右缘对齐按钮右缘 */
function showIoMenu(): void {
  const r = ioToggleBtn.getBoundingClientRect();
  ioMenuEl.style.left = `${Math.max(8, r.right - 220)}px`;
  ioMenuEl.style.top = `${r.bottom + 6}px`;
  ioMenuEl.style.display = 'block';
}
function hideIoMenu(): void {
  ioMenuEl.style.display = 'none';
}

ioToggleBtn.addEventListener('click', () => {
  if (ioMenuEl.style.display === 'block') hideIoMenu();
  else showIoMenu();
});
// 点外部关闭
window.addEventListener('pointerdown', (e) => {
  const t = e.target as Node;
  if (ioMenuEl.style.display === 'block' && !ioMenuEl.contains(t) && t !== ioToggleBtn) {
    hideIoMenu();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ioMenuEl.style.display === 'block') hideIoMenu();
});

// ---------- 各操作实现 ----------
const ioActions: Record<string, () => void> = {
  // 导入 XMind（Zen 新格式 + XMind 8 旧格式）
  'import-xmind'(): void {
    pickFile('.xmind', (buf) => {
      try {
        const { tree, warnings } = decodeXmind(new Uint8Array(buf), registry);
        loadDoc({
          version: 1,
          meta: { title: tree.text, updatedAt: new Date().toISOString() },
          tree,
          annotations: [],
        });
        if (warnings.length) toast(`导入完成，${warnings.length} 条警告：${warnings.slice(0, 3).join('；')}`, 'warn');
        else toast('导入成功', 'success');
      } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error');
      }
    });
  },
  // 导入 Markdown 大纲（此前只有导出，这里补齐互转闭环）
  'import-md'(): void {
    pickFile('.md,.markdown,.txt', (buf) => {
      try {
        const text = new TextDecoder().decode(buf);
        const { tree, warnings } = decodeMarkdown(text);
        loadDoc({
          version: 1,
          meta: { title: tree.text, updatedAt: new Date().toISOString() },
          tree,
          annotations: [],
        });
        if (warnings.length) toast(`导入完成，${warnings.length} 条警告：${warnings.slice(0, 3).join('；')}`, 'warn');
        else toast('导入成功', 'success');
      } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error');
      }
    });
  },
  // 导入导图 JSON（含批注/节点 id/props——完整备份恢复）
  'import-json'(): void {
    pickFile('.json', (buf) => {
      try {
        const d = JSON.parse(new TextDecoder().decode(buf)) as MindDocument;
        loadDoc(d);
      } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error');
      }
    });
  },
  'export-xmind'(): void {
    try {
      const bytes = encodeXmind(store.root, store.document.meta.title);
      download(`${store.document.meta.title || 'mindmap'}.xmind`, bytes.slice().buffer, 'application/octet-stream');
    } catch (e) {
      toast(`导出失败：${(e as Error).message}`, 'error');
    }
  },
  'export-md'(): void {
    try {
      const md = encodeMarkdown(store.root);
      download(`${store.document.meta.title || 'mindmap'}.md`, md, 'text/markdown');
    } catch (e) {
      toast(`导出失败：${(e as Error).message}`, 'error');
    }
  },
  'export-png'(): void {
    const url = renderer.exportPNG();
    if (!url) {
      toast('导图过大，PNG 会小到不可读。请先折叠部分分支再导出', 'warn');
      return;
    }
    // dataURL → Blob（download() 收 BlobPart）
    const bin = atob(url.split(',')[1] ?? '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    download(`${store.document.meta.title || 'mindmap'}.png`, bytes.buffer, 'image/png');
  },
  'export-json'(): void {
    download(`${store.document.meta.title || 'mindmap'}.json`, JSON.stringify(store.toJSON(), null, 2), 'application/json');
  },
};

// 菜单项点击分发
ioMenuEl.querySelectorAll('.item[data-io]').forEach((el) => {
  el.addEventListener('click', () => {
    const key = (el as HTMLElement).dataset.io!;
    hideIoMenu();
    ioActions[key]?.();
  });
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
    toast('先选中一个节点', 'info');
    return;
  }
  const node = store.getNode(selected.id)!;
  if (isLeafNode(selected.id)) {
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
  store = DocStore.fromJSON(registry, d);
  // doc 引用 store 内部对象：之后所有编辑都反映在 doc 上，persistCurrent/saveLocal 才不会写旧快照
  doc = store.toJSON();
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

// 防抖期间关闭页面时立即落盘
window.addEventListener('beforeunload', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persistCurrent();
    if (currentDocId) {
      try {
        localStorage.setItem(LS_EXPANDED + ':' + currentDocId, JSON.stringify([...(expandedIds ?? [])]));
      } catch {
        /* ignore */
      }
    }
  }
});

// ---------- 桥接服务（实时协作） ----------
const BRIDGE_URL = (localStorage.getItem('ai-mind-map:bridge') ?? 'http://localhost:47214').replace(/\/$/, '');
let lastPushAt = 0;

/** 外部（MCP/AI/另一浏览器）改了文档：重拉全量并刷新视图 */
async function pullRemote(): Promise<void> {
  if (Date.now() - lastPushAt < 1500) return; // 自己刚推送过，忽略回声
  try {
    const res = await fetch(`${BRIDGE_URL}/doc`);
    if (!res.ok) return;
    const d = (await res.json()) as MindDocument;
    loadDoc(d, true); // keepViewport: 平移缩放不动，只换数据
    expandedIds = null; // 默认展开深度
  } catch {
    /* bridge 未启动：静默降级为本地模式 */
  }
}

/** 启动时尝试连接 bridge 的 SSE（未启动则静默降级） */
function connectBridge(): void {
  try {
    const es = new EventSource(`${BRIDGE_URL}/events`);
    es.addEventListener('changed', () => {
      void pullRemote();
    });
    es.onerror = () => {
      /* 断线自动重连由 EventSource 内建 */
    };
  } catch {
    /* bridge 未启动 */
  }
}

/** 浏览器侧保存：写回 bridge（异步，失败静默——本地 localStorage 仍是兜底） */
async function pushRemote(): Promise<void> {
  lastPushAt = Date.now();
  try {
    await fetch(`${BRIDGE_URL}/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
  } catch {
    /* bridge 未启动 */
  }
}

// ---------- 多文档管理 ----------
interface DocEntry {
  id: string;
  title: string;
  updatedAt: number;
}

const DOCS_INDEX_KEY = 'ai-mind-map:docs'; // 索引：[{id,title,updatedAt}]
const DOC_PREFIX = 'ai-mind-map:doc:';      // 每文档数据键
const LAST_DOC_KEY = 'ai-mind-map:last-doc';

function loadDocsIndex(): DocEntry[] {
  try {
    return JSON.parse(localStorage.getItem(DOCS_INDEX_KEY) ?? '[]') as DocEntry[];
  } catch {
    return [];
  }
}

function saveDocsIndex(entries: DocEntry[]): void {
  localStorage.setItem(DOCS_INDEX_KEY, JSON.stringify(entries));
}

/** 文档保存时同步索引里的标题与时间戳 */
function touchDocEntry(id: string, title: string): void {
  const entries = loadDocsIndex();
  const e = entries.find((x) => x.id === id);
  if (e) {
    e.title = title;
    e.updatedAt = Date.now();
    saveDocsIndex(entries);
  }
}

function deleteDoc(id: string): void {
  localStorage.removeItem(DOC_PREFIX + id);
  saveDocsIndex(loadDocsIndex().filter((x) => x.id !== id));
}

// ---------- 启动 ----------
// 多文档：读 last-doc 指向的文档；无任何文档时创建演示文档
let currentDocId: string | null = localStorage.getItem(LAST_DOC_KEY);

/** 把当前 doc/store 的内容保存到其文档槽位并更新索引 */
function persistCurrent(): void {
  if (!currentDocId) return;
  try {
    localStorage.setItem(DOC_PREFIX + currentDocId, JSON.stringify(doc));
    touchDocEntry(currentDocId, store.document.meta.title || '未命名导图');
  } catch {
    /* 存储满：静默 */
  }
}

/** 打开一个文档（从其槽位加载，失效则新建） */
function openDoc(id: string): void {
  const raw = localStorage.getItem(DOC_PREFIX + id);
  let d: MindDocument | null = null;
  if (raw) {
    try {
      d = JSON.parse(raw) as MindDocument;
    } catch {
      d = null;
    }
  }
  currentDocId = id;
  localStorage.setItem(LAST_DOC_KEY, id);
  loadDoc(d ?? makeDemo(), false);
  // 每文档独立的展开状态
  const rawExp = localStorage.getItem(LS_EXPANDED + ':' + id);
  if (rawExp) {
    try {
      const arr = JSON.parse(rawExp) as string[];
      expandedIds = arr.length ? new Set(arr) : null;
      relayout();
    } catch {
      expandedIds = null;
    }
  }
}

/** 新建文档并打开 */
function createDoc(title?: string): string {
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const d = blankDoc(title ?? '未命名导图');
  localStorage.setItem(DOC_PREFIX + id, JSON.stringify(d));
  const entries = loadDocsIndex();
  entries.unshift({ id, title: d.meta.title, updatedAt: Date.now() });
  saveDocsIndex(entries);
  localStorage.setItem(LAST_DOC_KEY, id);
  showHome(false); // 先关首页再装载，进入编辑器
  openDoc(id);
  return id;
}

/** 首页文件列表行（文件名 + 行内操作） */
function cardHtml(e: DocEntry): string {
  const initial = (e.title || '?').slice(0, 1);
  const when = e.updatedAt
    ? new Date(e.updatedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  const hues = ['#3b82f6', '#22d3ee', '#4ade80', '#f59e0b', '#f472b6', '#a78bfa', '#34d399'];
  const accent = hues[(e.title || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length]!;
  const nodeCount = docNodeCount(e.id);
  return `
    <div class="doc-row" data-id="${e.id}" style="display:flex;align-items:center;gap:14px;padding:13px 18px;background:#fff;border-bottom:1px solid #eef2f7;cursor:pointer;transition:background 0.14s ease"
      onmouseover="this.style.background='#f8faff';this.querySelector('.doc-actions').style.opacity='1'"
      onmouseout="this.style.background='#fff';this.querySelector('.doc-actions').style.opacity='0'">
      <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,${accent},${accent}cc);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;flex-shrink:0">${escapeHtml(initial)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.title)}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:1px">测试用例导图</div>
      </div>
      <span style="width:110px;font-size:12.5px;color:#64748b">${nodeCount.toLocaleString()} 节点</span>
      <span style="width:150px;font-size:12px;color:#94a3b8">${when}</span>
      <div class="doc-actions" style="width:132px;display:flex;gap:6px;justify-content:flex-end;opacity:0;transition:opacity 0.14s ease">
        <button class="btn" data-open="${e.id}" style="background:#eff6ff;border:1px solid #bfdbfe;color:#2563eb;padding:5px 12px;border-radius:7px;font-size:12px">打开</button>
        <button class="btn" data-rename="${e.id}" title="重命名" style="background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:5px 8px;border-radius:7px;font-size:12px">改名</button>
        <button class="btn" data-delete="${e.id}" title="删除" style="background:#fff;border:1px solid #fecaca;color:#dc2626;padding:5px 8px;border-radius:7px;font-size:12px">删除</button>
      </div>
    </div>
  `;
}

/** 文档节点数（读槽位 JSON 粗算，卡片展示用） */
function docNodeCount(id: string): number {
  try {
    const raw = localStorage.getItem(DOC_PREFIX + id);
    if (!raw) return 0;
    const d = JSON.parse(raw) as MindDocument;
    const count = (n: { children?: unknown[] }): number =>
      1 + (n.children ?? []).reduce((acc: number, c) => acc + count(c as { children?: unknown[] }), 0);
    return count(d.tree) - 1; // 不含根
  } catch {
    return 0;
  }
}

/** 渲染首页项目卡片网格 */
function renderHome(): void {
  const grid = document.getElementById('home-grid') as HTMLDivElement;
  const entries = loadDocsIndex().sort((a, b) => b.updatedAt - a.updatedAt);
  // 顶栏统计：项目数 / 总节点数
  const statsEl = document.getElementById('home-stats');
  if (statsEl) {
    const total = entries.reduce((acc, e) => acc + docNodeCount(e.id), 0);
    statsEl.innerHTML = `
      <span><b style="color:#1e293b">${entries.length}</b> 个项目</span>
      <span><b style="color:#1e293b">${total.toLocaleString()}</b> 个节点</span>
    `;
  }
  grid.style.borderRadius = entries.length ? '12px' : '0';
  grid.style.overflow = entries.length ? 'hidden' : 'visible';
  grid.style.border = entries.length ? '1px solid #e8edf3' : 'none';
  grid.innerHTML =
    entries.length === 0
      ? `<div style="text-align:center;padding:72px 0;border:1px dashed #cbd5e1;border-radius:14px;background:#fbfdff;margin-top:14px">
           <div style="font-size:34px;margin-bottom:10px">🗺</div>
           <div style="color:#475569;font-size:14px;margin-bottom:6px">还没有导图</div>
           <div style="color:#94a3b8;font-size:12.5px">点击右上角「＋ 新建导图」开始，或导入现有文件</div>
         </div>`
      : entries.map((e) => cardHtml(e)).join('');
  // 卡片整体可点（打开）；按钮冒泡已由 data-* 分发处理
  grid.querySelectorAll('.doc-row').forEach((el) =>
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return; // 按钮各自处理
      showHome(false);
      openDoc((el as HTMLElement).dataset.id!);
    }),
  );
  grid.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => {
      showHome(false);
      openDoc((el as HTMLElement).dataset.open!);
    }),
  );
  grid.querySelectorAll('[data-rename]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.rename!;
      const entries2 = loadDocsIndex();
      const cur = entries2.find((x) => x.id === id);
      const next = prompt('重命名导图', cur?.title ?? '')?.trim();
      if (next) {
        // 同步改文档 meta.title
        try {
          const raw = localStorage.getItem(DOC_PREFIX + id);
          if (raw) {
            const d = JSON.parse(raw) as MindDocument;
            d.meta.title = next;
            localStorage.setItem(DOC_PREFIX + id, JSON.stringify(d));
          }
        } catch { /* ignore */ }
        cur!.title = next;
        saveDocsIndex(entries2);
        renderHome();
      }
    }),
  );
  grid.querySelectorAll('[data-delete]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.delete!;
      const cur = loadDocsIndex().find((x) => x.id === id);
      if (confirm(`删除「${cur?.title ?? '未命名'}」？删除后不可恢复。`)) {
        deleteDoc(id);
        renderHome();
      }
    }),
  );
}

/** 显示/隐藏首页；离开编辑器前先保存当前文档 */
function showHome(show: boolean): void {
  const home = document.getElementById('home-view') as HTMLDivElement;
  home.style.display = show ? 'block' : 'none';
  if (!show) return;
  persistCurrent();
  renderHome();
}

// 首页按钮
document.getElementById('home-new')?.addEventListener('click', () => {
  const title = prompt('新导图名称', '未命名导图');
  if (title === null) return;
  createDoc(title.trim() || undefined);
});
document.getElementById('home-import')?.addEventListener('click', () => {
  // 复用导入 JSON 通道：导入后存为新文档
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.xmind,.md,.markdown,.txt';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => {
      try {
        const name = f.name;
        let tree;
        if (name.endsWith('.xmind')) {
          tree = decodeXmind(new Uint8Array(buf), registry).tree;
        } else if (/\.(md|markdown|txt)$/.test(name)) {
          tree = decodeMarkdown(new TextDecoder().decode(buf)).tree;
        } else {
          loadDoc(JSON.parse(new TextDecoder().decode(buf)));
          // loadDoc 已把内容装进 store；打包成新文档
          const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          localStorage.setItem(DOC_PREFIX + id, JSON.stringify(store.toJSON()));
          const entries = loadDocsIndex();
          entries.unshift({ id, title: store.document.meta.title, updatedAt: Date.now() });
          saveDocsIndex(entries);
          localStorage.setItem(LAST_DOC_KEY, id);
          showHome(false);
          toast('已导入为新文档', 'success');
          return;
        }
        const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const d: MindDocument = {
          version: 1,
          meta: { title: tree.text, updatedAt: new Date().toISOString() },
          tree,
          annotations: [],
        };
        localStorage.setItem(DOC_PREFIX + id, JSON.stringify(d));
        const entries = loadDocsIndex();
        entries.unshift({ id, title: d.meta.title, updatedAt: Date.now() });
        saveDocsIndex(entries);
        localStorage.setItem(LAST_DOC_KEY, id);
        showHome(false);
        openDoc(id);
        toast('已导入为新文档', 'success');
      } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error');
      }
    });
  };
  input.click();
});

// 顶部 logo 点击返回首页
document.getElementById('home-btn')?.addEventListener('click', () => {
  showHome(true);
});

// ---------- 启动装载 ----------
// 旧版单文档键迁移为多文档槽位（一次性）
(function migrateLegacyDoc(): void {
  const legacy = loadLocal();
  if (!legacy) return;
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    localStorage.setItem(DOC_PREFIX + id, JSON.stringify(legacy));
    const entries = loadDocsIndex();
    entries.unshift({ id, title: legacy.meta.title || '未命名导图', updatedAt: Date.now() });
    saveDocsIndex(entries);
    localStorage.setItem(LAST_DOC_KEY, id);
  } catch {
    /* ignore */
  }
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_EXPANDED);
})();

if (!loadDocsIndex().length) {
  // 首次使用：预置演示文档
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const d = makeDemo();
  try {
    localStorage.setItem(DOC_PREFIX + id, JSON.stringify(d));
    const entries = loadDocsIndex();
    entries.unshift({ id, title: d.meta.title, updatedAt: Date.now() });
    saveDocsIndex(entries);
    localStorage.setItem(LAST_DOC_KEY, id);
  } catch {
    /* ignore */
  }
}

// 打开上次编辑的文档；否则显示首页
const lastId = localStorage.getItem(LAST_DOC_KEY);
if (lastId && localStorage.getItem(DOC_PREFIX + lastId)) {
  openDoc(lastId);
  showHome(false);
} else {
  // 先装载一个空文档占位（renderer 需要），再弹首页
  loadDoc(blankDoc('未命名导图'), false);
  showHome(true);
}
updateZoomPct();

// 主题
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) {
  (document.getElementById('theme-select') as HTMLSelectElement).value = savedTheme;
  applyTheme(savedTheme);
}
document.getElementById('theme-select')?.addEventListener('change', (e) => {
  applyTheme((e.target as HTMLSelectElement).value);
});

// 布局方向切换
const layoutSelect = document.getElementById('layout-select') as HTMLSelectElement;
layoutSelect.value = layoutDir;
layoutSelect.addEventListener('change', () => {
  layoutDir = layoutSelect.value as LayoutDir;
  localStorage.setItem(LAYOUT_KEY, layoutDir);
  relayout();
  renderer.focusNode(store.root.id);
  toast(`已切换为「${LAYOUT_LABELS[layoutDir]}」布局`, 'info');
});

// 暴露给自动化测试 / 控制台调试
(window as unknown as Record<string, unknown>).renderer = renderer;
(window as unknown as Record<string, unknown>).store = () => store;
(window as unknown as Record<string, unknown>).appState = () => ({ selected, expandedIds });

// 桥接：启动连接
connectBridge();

// ---------- AI 助手抽屉 ----------
const aiDrawer = document.getElementById('ai-drawer') as HTMLDivElement;
const aiLog = document.getElementById('ai-log') as HTMLDivElement;
const aiInput = document.getElementById('ai-input') as HTMLTextAreaElement;
const aiSendBtn = document.getElementById('ai-send') as HTMLButtonElement;

function toggleAiDrawer(): void {
  const open = aiDrawer.style.display !== 'flex';
  aiDrawer.style.display = open ? 'flex' : 'none';
  if (open) aiInput.focus();
}
document.getElementById('ai-toggle')?.addEventListener('click', toggleAiDrawer);
document.getElementById('ai-close')?.addEventListener('click', toggleAiDrawer);

/** 追加一条消息气泡；返回文本容器（AI 流式填充用） */
function addBubble(role: 'user' | 'ai' | 'sys'): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = `ai-bubble ${role}`;
  const isUser = role === 'user';
  const isAi = role === 'ai';
  bubble.style.cssText =
    `max-width:92%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.55;` +
    `white-space:pre-wrap;word-break:break-word;` +
    `align-self:${isUser ? 'flex-end' : 'flex-start'};` +
    `background:${isUser ? '#2563eb' : isAi ? '#f5f3ff' : '#f1f5f9'};` +
    `color:${isUser ? '#fff' : '#1e293b'}`;
  const text = document.createElement('div');
  text.className = 'ai-text';
  bubble.appendChild(text);
  aiLog.appendChild(bubble);
  aiLog.scrollTop = aiLog.scrollHeight;
  return text;
}

addBubble('sys').textContent = '连接 bridge 后可让 AI 直接读写当前导图（未启动 bridge 时提示 make bridge）。';

async function sendAiMessage(): Promise<void> {
  const message = aiInput.value.trim();
  if (!message) return;
  aiInput.value = '';
  addBubble('user').textContent = message;

  const aiText = addBubble('ai');
  aiText.textContent = '思考中…';
  aiSendBtn.disabled = true;

  try {
    const res = await fetch(`${BRIDGE_URL}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch { /* 非 JSON 错误体 */ }
      aiText.textContent = `AI 请求失败：${msg}`;
      return;
    }
    if (!res.body) {
      aiText.textContent = 'AI 请求失败：无响应流';
      return;
    }

    // 解析 SSE（text 流式 / done / error）
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine = chunk.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!evLine || !dataLine) continue;
        const ev = evLine.slice(7);
        const data = JSON.parse(dataLine.slice(6)) as { error?: string; toolCalls?: number };
        if (ev === 'text') {
          if (aiText.textContent === '思考中…') aiText.textContent = '';
          aiText.textContent += String(data);
          aiLog.scrollTop = aiLog.scrollHeight;
        } else if (ev === 'done') {
          aiText.textContent = aiText.textContent || '（完成）';
        } else if (ev === 'error') {
          aiText.textContent += `\n[错误] ${data.error ?? ''}`;
        }
      }
    }
    if (!aiText.textContent) aiText.textContent = '（无回复）';
  } catch {
    aiText.textContent = '无法连接 bridge（默认 http://localhost:47214）。启动方式：make bridge';
  } finally {
    aiSendBtn.disabled = false;
    aiInput.focus();
  }
}

aiSendBtn.addEventListener('click', () => void sendAiMessage());
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendAiMessage();
  }
});

