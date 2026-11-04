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
import {
  reconcileDocsIndex,
  type BridgeDocInfo,
  type DocEntry,
} from './doc-index-sync.js';

const THEME_KEY = 'ai-mind-map:theme';

function applyTheme(name: string): void {
  const t = builtinThemeRefs[name];
  if (t) renderer.setTheme(t.theme);
  localStorage.setItem(THEME_KEY, name);
}
import {
  BUILTIN_TEMPLATES,
  CASE_TYPES,
  TEST_LEVELS,
  type CaseProps,
  type ExecStatus,
  type FolderProps,
  PRIORITY_SPECS,
  buildTemplateDoc,
  type MindDocument,
} from '@ai-mind-map/core';

const registry = new NodeTypeRegistry();
registerBuiltinTypes(registry);

// ---------- 演示文档已移除 ----------
// 旧版会在首次使用时自动生成演示文档「订单中心 · 回归测试」（1.2 万节点模板数据）。
// 它曾被 openDoc 的占位逻辑当成真实内容推送/覆盖到 bridge，造成线上真实用例被清空；
// 且该内容本就不应出现在业务部署里。现彻底移除生成逻辑，仅保留标题常量用于
// 启动时清理旧浏览器里残留的演示副本（见 purgeDemoDocs）。
const DEMO_TITLE = '订单中心 · 回归测试';

function blankDoc(title = '新导图'): MindDocument {
  const s = new DocStore(registry, {
    meta: { title, updatedAt: new Date().toISOString() },
  });
  // 根节点名称默认取文档名（一次性快照：此后各自独立编辑，互不联动）
  s.updateNode(s.root.id, { text: title });
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
    if (!pendingRemoteFill) persistCurrent(); // 占位等待远端填充期间不落盘
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

/**
 * true = 当前文档内容是「空白占位」，正在等待 bridge 填充真实内容。
 * 占位期间禁止落盘/推送：曾因把演示文档当占位装载并自动保存，
 * 将 bridge 上的真实文档覆盖成了「订单中心 · 回归测试」。
 */
let pendingRemoteFill = false;

// ---------- 历史栈（撤销/重做） ----------
const MAX_HISTORY = 100;
let history: string[] = [];
let future: string[] = [];
let suppress = false;

/** 在 mutation 之前调用，保存变更前状态 */
function snapshot(): void {
  if (suppress || !store) return;
  // 用户显式编辑占位文档：视为接受当前内容，恢复正常落盘/推送（bridge 离线时不至于永远锁死）
  pendingRemoteFill = false;
  // 用户显式编辑「本地专用文档」（冲突备份等）：它升级为普通文档，恢复参与同步
  if (currentDocId) {
    const entry = loadDocsIndex().find((x) => x.id === currentDocId);
    if (entry?.keepLocalOnly) {
      entry.keepLocalOnly = false;
      saveDocsIndex(loadDocsIndex().map((x) => (x.id === currentDocId ? entry : x)));
    }
  }
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
  onViewportChange: () => updateZoomPct(),
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

// ---------- 默认展开层级设置 ----------
type ExpandDepth = 1 | 2 | 3 | 'all';
const EXPAND_DEPTH_KEY = 'ai-mind-map:default-expand-depth';
function normalizeExpandDepth(v: string | null): ExpandDepth {
  if (v === '1' || v === '2' || v === '3') return Number(v) as 1 | 2 | 3;
  if (v === 'all') return 'all';
  return 2;
}
let defaultExpandDepth: ExpandDepth = normalizeExpandDepth(localStorage.getItem(EXPAND_DEPTH_KEY));
/** 传给 layoutTree 的 defaultExpandDepth（'all' 用一个大数表示全部展开） */
function expandDepthOption(): number {
  return defaultExpandDepth === 'all' ? Number.MAX_SAFE_INTEGER : defaultExpandDepth;
}
function expandDepthLabel(): string {
  return defaultExpandDepth === 'all' ? '全部' : `${defaultExpandDepth} 层`;
}

/** 布局 + 渲染 + 统计 + 持久化。selected 传 id 保持选中跨布局。 */
function relayout(): void {
  const flat = layoutTree(store.root, registry, {
    defaultExpandDepth: expandDepthOption(),
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
  refreshStatsIfOpen();
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
  ensureExpandedInit();
  if (expandedIds!.has(id)) expandedIds!.delete(id);
  else expandedIds!.add(id);
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

/** 设置/清除用例执行标记（pass/blocked/fail；undefined=未执行，不展示） */
function setNodeExec(id: string, exec: ExecStatus | undefined): void {
  const node = store.getNode(id);
  if (!node) return;
  if (((node.props as CaseProps).exec ?? undefined) === exec) return; // 状态未变不产生撤销步骤
  snapshot();
  store.updateNode(id, { props: { exec: exec ?? undefined } });
  relayout();
  renderOutlineIfVisible();
  syncExecChips(id, exec);
}

/** 同步面板「执行状态」按钮的选中态（只改 class，不重建表单，避免丢掉未保存的编辑） */
function syncExecChips(id: string, exec: ExecStatus | undefined): void {
  if (selected?.id !== id) return;
  document.querySelectorAll<HTMLButtonElement>('#panel [data-exec]').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.exec ?? '') === (exec ?? ''));
  });
}

/** 大纲可见时刷新（保持滚动位置由 syncOutlineToSelection 处理） */
function renderOutlineIfVisible(): void {
  if (outlineMode) renderOutline();
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
  // 高度随内容自适应：初始贴合节点，输入换行后编辑框跟着长高，
  // 避免文本溢出框外压到画布上的其他节点
  ed.style.height = 'auto';
  ed.style.minHeight = `${r.height}px`;
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
      addChild(selId, 'folder', '新路径'); // Tab 只建路径节点；用例走「+ 用例」按钮
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

/** 同步展开状态与挂起保存；SSE/远端刷新不能把用户刚做的折叠丢掉 */
function persistExpandedNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!pendingRemoteFill) persistCurrent(); // 占位等待远端填充期间不落盘
  if (currentDocId) {
    try {
      localStorage.setItem(LS_EXPANDED + ':' + currentDocId, JSON.stringify([...(expandedIds ?? [])]));
    } catch {
      /* 存储满：静默 */
    }
  }
}

searchInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME 组合态
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
      label: leaf ? '新建子节点（用例不可含子节点）' : '新建子节点（路径）',
      kbd: 'Tab',
      // 叶子节点按 Tab 自动降级为新建同级（XMind 行为）
      action: () => (leaf ? addSibling(node.id) : addChild(node.id, 'folder', '新路径')),
      disabled: leaf,
      disabledHint: leaf ? '按 Tab/Enter 将自动新建同级节点' : undefined,
    },
    {
      label: '新建用例节点',
      action: () => (leaf ? addSibling(node.id) : addChild(node.id, 'case', '新用例')),
      disabled: leaf,
      disabledHint: leaf ? '用例下不能建用例；Enter 新建同级用例' : undefined,
    },
    { label: '新建同级节点', kbd: 'Enter', action: () => addSibling(node.id), },
    { label: '编辑文本', kbd: 'F2', action: () => startEdit(node.id) },
    { label: '设置节点样式…', action: () => showStylePanel(node.id) },
    ...(node.type === 'case'
      ? [
          { label: '✓ 标记通过', action: () => setNodeExec(node.id, 'pass') },
          { label: '⏸ 标记阻塞', action: () => setNodeExec(node.id, 'blocked') },
          { label: '✗ 标记失败', action: () => setNodeExec(node.id, 'fail') },
          { label: '↺ 标记未执行', action: () => setNodeExec(node.id, undefined) },
        ]
      : []),
    { label: '展开/折叠', kbd: 'Space', action: () => toggleCollapse(node.id), divider: !leaf },
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

// ---------- 面板宽度拖拽 ----------
const PANEL_WIDTH_KEY = 'ai-mind-map:panel-width';
const PANEL_WIDTH_DEFAULT = 340;
const PANEL_WIDTH_MIN = 280;
const PANEL_WIDTH_MAX = 760;
const panelResizer = document.getElementById('panel-resizer') as HTMLElement | null;

/** 面板最大宽度：小屏时给画布留出空间 */
function panelWidthLimit(): number {
  return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, window.innerWidth - 420));
}

/** 应用面板宽度（px 会被夹在 [MIN, limit]）；persist 时写入 localStorage */
function setPanelWidth(px: number, persist = true): number {
  const w = Math.round(Math.max(PANEL_WIDTH_MIN, Math.min(panelWidthLimit(), px)));
  aside.style.width = `${w}px`;
  // 宽度变化后重新布局面板内容：文本域自动增高、长标题折叠判断
  autosizePanelTextareas();
  refreshTitleOverflow();
  if (persist) localStorage.setItem(PANEL_WIDTH_KEY, String(w));
  return w;
}

const savedPanelWidth = Number(localStorage.getItem(PANEL_WIDTH_KEY));
setPanelWidth(Number.isFinite(savedPanelWidth) && savedPanelWidth > 0 ? savedPanelWidth : PANEL_WIDTH_DEFAULT, false);

let panelDrag: { startX: number; startW: number } | null = null;
function endPanelDrag(): void {
  if (!panelDrag) return;
  panelDrag = null;
  panelResizer?.classList.remove('dragging');
  document.body.classList.remove('panel-resizing');
  localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(aside.getBoundingClientRect().width)));
}
panelResizer?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  panelDrag = { startX: e.clientX, startW: aside.getBoundingClientRect().width };
  panelResizer.classList.add('dragging');
  document.body.classList.add('panel-resizing');
  panelResizer.setPointerCapture(e.pointerId);
});
panelResizer?.addEventListener('pointermove', (e) => {
  if (!panelDrag) return;
  setPanelWidth(panelDrag.startW + (panelDrag.startX - e.clientX), false);
});
panelResizer?.addEventListener('pointerup', endPanelDrag);
panelResizer?.addEventListener('pointercancel', endPanelDrag);
panelResizer?.addEventListener('dblclick', () => setPanelWidth(PANEL_WIDTH_DEFAULT));
panelResizer?.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const step = e.shiftKey ? 40 : 12;
  setPanelWidth(aside.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? step : -step));
});
// 窗口变窄时夹住宽度，避免画布被挤没（不覆盖用户保存的宽度）
window.addEventListener('resize', () => setPanelWidth(aside.getBoundingClientRect().width, false));

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 复制图标（两个叠放的矩形，剪贴板语义） */
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<rect x="5.5" y="4.5" width="7.5" height="9" rx="1.6" stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M10.5 4V3.3c0-.72-.58-1.3-1.3-1.3H4.3C3.58 2 3 2.58 3 3.3v6.9c0 .72.58 1.3 1.3 1.3h1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg>';

/** 复制文本到剪贴板并提示（HTTP 等非安全上下文直接回退 execCommand）。 */
async function copyText(text: string, label: string): Promise<boolean> {
  const legacyCopy = (): boolean => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const copied = document.execCommand('copy');
    ta.remove();
    return copied;
  };

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!legacyCopy()) {
      throw new Error('legacy clipboard unavailable');
    }
  } catch {
    try {
      if (!legacyCopy()) throw new Error('copy command rejected');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
      return false;
    }
  }
  toast(`已复制${label}`, 'success');
  return true;
}

/**
 * 文本域高度随内容自适应，避免长文本被固定高度裁切。
 * box-sizing 为 border-box，scrollHeight 不含边框，故补上上下边框（含内边距）后再设高。
 */
function autosizeTextarea(ta: HTMLTextAreaElement): void {
  const cs = getComputedStyle(ta);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  ta.style.height = 'auto';
  ta.style.height = `${Math.ceil(ta.scrollHeight + border)}px`;
}

/** 侧边面板渲染/切换后统一自适应（含批注回复框、新增步骤等） */
function autosizePanelTextareas(): void {
  aside.querySelectorAll('textarea').forEach((el) => autosizeTextarea(el as HTMLTextAreaElement));
}

// 输入时即时增高；缩到合适高度由 autosizeTextarea 自动收敛
aside.addEventListener('input', (e) => {
  const ta = e.target as HTMLElement | null;
  if (ta instanceof HTMLTextAreaElement) autosizeTextarea(ta);
});

/** 执行状态选项：空 key = 未执行（默认，画布/大纲不展示） */
const EXEC_OPTIONS: Array<{ key: '' | ExecStatus; label: string }> = [
  { key: '', label: '未执行' },
  { key: 'pass', label: '✓ 通过' },
  { key: 'blocked', label: '⏸ 阻塞' },
  { key: 'fail', label: '✗ 失败' },
];

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
      <div class="node-title-row">
        <div class="node-title" title="${escapeHtml(node.text)}">${iconHtml}<span class="title-text" id="panel-title-text">${escapeHtml(node.text)}</span></div>
        <button class="copy-btn" id="copy-node-title" title="复制节点名称" aria-label="复制节点名称">${COPY_ICON}</button>
      </div>
      <button class="title-toggle" id="panel-title-toggle" style="display:none">展开全文 ▾</button>
      <div class="node-meta">
        <span>${typeLabel}</span><span>·</span><span>编号</span>
        <code class="node-id">${escapeHtml(node.id)}</code>
        <button class="copy-btn small" id="copy-node-id" title="复制节点编号" aria-label="复制节点编号">${COPY_ICON}</button>
      </div>
    </div>
    <div class="tabs">
      <div class="tab ${panelTab === 'info' ? 'active' : ''}" data-tab="info">节点信息</div>
      <div class="tab ${panelTab === 'anns' ? 'active' : ''}" data-tab="anns">批注${openCount ? `<span class="badge-count">${openCount}</span>` : ''}</div>
    </div>
    <div class="panel-body" id="panel-body"></div>
  `;
  // 节点名称 / 唯一编号：一键复制
  aside.querySelector('#copy-node-title')?.addEventListener('click', () => void copyText(node.text, '节点名称'));
  aside.querySelector('#copy-node-id')?.addEventListener('click', () => void copyText(node.id, '节点编号'));
  // 节点标题过长时折叠为 3 行，可展开全文（避免标题把面板正文挤没）
  const titleTextEl = aside.querySelector<HTMLElement>('#panel-title-text');
  const titleToggleEl = aside.querySelector<HTMLButtonElement>('#panel-title-toggle');
  titleToggleEl?.addEventListener('click', () => {
    if (!titleTextEl) return;
    const expanded = titleTextEl.classList.toggle('expanded');
    titleToggleEl.textContent = expanded ? '收起 ▴' : '展开全文 ▾';
  });
  refreshTitleOverflow();
  aside.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      panelTab = (t as HTMLElement).dataset.tab as 'info' | 'anns';
      renderPanel();
    }),
  );
  const body = document.getElementById('panel-body')!;
  if (panelTab === 'info') renderInfoForm(body, node);
  else renderAnnotations(body, node);
  autosizePanelTextareas();
  syncOutlineToSelection();
}

/** 面板宽度变化后重新判断标题是否需要“展开全文” */
function refreshTitleOverflow(): void {
  const t = aside.querySelector<HTMLElement>('#panel-title-text');
  const btn = aside.querySelector<HTMLButtonElement>('#panel-title-toggle');
  if (!t || !btn) return;
  if (t.classList.contains('expanded')) {
    btn.style.display = 'inline-block';
    return;
  }
  btn.style.display = t.scrollHeight > t.clientHeight + 1 ? 'inline-block' : 'none';
}

function renderInfoForm(body: HTMLElement, node: MindNode): void {
  const isCase = node.type === 'case'; // 内置用例类型显示专有表单；其他类型走通用表单
  if (isCase) {
    const p = node.props as CaseProps;
    body.innerHTML = `
      <div class="field" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">
        <div>
          <label>优先级</label>
          <select id="f-priority">
            <option value="">未设置</option>
            ${['P0', 'P1', 'P2', 'P3']
              .map(
                (x) =>
                  `<option ${p.priority === x ? 'selected' : ''} title="${escapeHtml(PRIORITY_SPECS[x as keyof typeof PRIORITY_SPECS].definition)}">${x}</option>`,
              )
              .join('')}
          </select>
          <div class="priority-hint" id="f-priority-hint" style="margin-top:4px;font-size:10.5px;line-height:1.4;color:#94a3b8">
            ${p.priority && PRIORITY_SPECS[p.priority] ? escapeHtml(PRIORITY_SPECS[p.priority].execution) : '未设置：不参与按优先级的发布/回归筛选'}
          </div>
        </div>
        <div>
          <label>用例类型</label>
          <select id="f-casetype">
            <option value="">未设置</option>
            ${CASE_TYPES.map((t) => `<option value="${t.key}" ${p.caseType === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>测试层级</label>
          <select id="f-testlevel">
            <option value="">未设置</option>
            ${TEST_LEVELS.map((level) => `<option value="${level.key}" ${p.testLevel === level.key ? 'selected' : ''}>${level.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label>执行状态</label>
        <div class="exec-row" id="f-exec">
          ${EXEC_OPTIONS.map(
            (o) =>
              `<button type="button" class="exec-chip${o.key ? ` exec-${o.key}` : ''}${(p.exec ?? '') === o.key ? ' active' : ''}" data-exec="${o.key}">${o.label}</button>`,
          ).join('')}
        </div>
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
      <div class="field">
        <label>备注</label>
        <textarea id="f-remark" style="min-height:40px">${escapeHtml(p.remark ?? '')}</textarea>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="btn-save-case">保存</button>
      </div>
    `;
    document.getElementById('btn-add-step')?.addEventListener('click', () => {
      const ta = document.createElement('textarea');
      ta.setAttribute('data-step', '');
      document.getElementById('steps-list')!.appendChild(ta);
      autosizeTextarea(ta);
      ta.focus();
    });
    // 执行状态：点击即标记（立即反映到画布/大纲，不走「保存」流程）
    body.querySelectorAll<HTMLButtonElement>('[data-exec]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const key = (btn.dataset.exec ?? '') as '' | ExecStatus;
        setNodeExec(node.id, key || undefined);
      }),
    );
    // 优先级提示：随选择更新（展示该等级的执行/发布要求）
    document.getElementById('f-priority')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as keyof typeof PRIORITY_SPECS | '';
      const hint = document.getElementById('f-priority-hint');
      if (hint) hint.textContent = value && PRIORITY_SPECS[value] ? PRIORITY_SPECS[value].execution : '未设置：不参与按优先级的发布/回归筛选';
    });
    document.getElementById('btn-save-case')?.addEventListener('click', () => {
      const steps = [...body.querySelectorAll('textarea[data-step]')]
        .map((t) => (t as HTMLTextAreaElement).value.trim())
        .filter(Boolean);
      const priority = (document.getElementById('f-priority') as HTMLSelectElement).value;
      const caseType = (document.getElementById('f-casetype') as HTMLSelectElement).value;
      const testLevel = (document.getElementById('f-testlevel') as HTMLSelectElement).value;
      snapshot();
      store.updateNode(node.id, {
        props: {
          priority: priority || undefined,
          caseType: caseType || undefined,
          testLevel: testLevel || undefined,
          precondition: (document.getElementById('f-precondition') as HTMLTextAreaElement).value.trim() || undefined,
          steps: steps.length ? steps : undefined,
          expected: (document.getElementById('f-expected') as HTMLTextAreaElement).value.trim() || undefined,
          remark: (document.getElementById('f-remark') as HTMLTextAreaElement).value.trim() || undefined,
        },
      });
      relayout();
      toast('已保存', 'success');
    });
  } else {
    const note = String((node.props as FolderProps).note ?? '');
    const detail = String((node.props as FolderProps).detail ?? '');
    const leaf = registry.get(node.type).leafOnly === true;
    body.innerHTML = `
      <div class="field">
        <label>详情</label>
        <textarea id="f-detail" style="min-height:96px" placeholder="长文本放这里：背景说明、数据清单、参考链接等；节点标题保持简短">${escapeHtml(detail)}</textarea>
      </div>
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
        props: {
          detail: (document.getElementById('f-detail') as HTMLTextAreaElement).value.trim() || undefined,
          note: (document.getElementById('f-note') as HTMLTextAreaElement).value.trim() || undefined,
        },
      });
      relayout();
      toast('已保存', 'success');
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

// ---------- 统计概览（左上角浮层：工具条「概览」/ 顶栏 stats 开关） ----------
let statsPopover: HTMLDivElement | null = null;

const PRIORITY_STATS: Array<{ key: string; label: string; color: string }> = [
  { key: 'P0', label: 'P0', color: '#dc2626' },
  { key: 'P1', label: 'P1', color: '#ea580c' },
  { key: 'P2', label: 'P2', color: '#2563eb' },
  { key: 'P3', label: 'P3', color: '#94a3b8' },
  { key: '', label: '未设置', color: '#cbd5e1' },
];
const EXEC_STATS: Array<{ key: string; label: string; color: string }> = [
  { key: 'pass', label: '通过', color: '#16a34a' },
  { key: 'blocked', label: '阻塞', color: '#eab308' },
  { key: 'fail', label: '失败', color: '#dc2626' },
  { key: '', label: '未执行', color: '#94a3b8' },
];

/** 统计当前文档：节点数 / 用例数 / 优先级分布 / 执行状态分布 */
function computeOverview(): {
  totalNodes: number;
  cases: MindNode[];
  priority: Map<string, number>;
  exec: Map<string, number>;
  executed: number;
} {
  const cases: MindNode[] = [];
  let totalNodes = 0;
  const walk = (n: MindNode): void => {
    totalNodes++;
    if (n.type === 'case') cases.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(store.root);
  const priority = new Map<string, number>();
  const exec = new Map<string, number>();
  let executed = 0;
  for (const c of cases) {
    const pr = String((c.props as { priority?: string }).priority ?? '');
    priority.set(pr, (priority.get(pr) ?? 0) + 1);
    const ex = String((c.props as { exec?: string }).exec ?? '');
    exec.set(ex, (exec.get(ex) ?? 0) + 1);
    if (ex === 'pass' || ex === 'fail' || ex === 'blocked') executed++;
  }
  return { totalNodes, cases, priority, exec, executed };
}

function overviewBodyHtml(): string {
  const { totalNodes, cases, priority, exec, executed } = computeOverview();
  const chips = (items: Array<{ key: string; label: string; color: string }>, counts: Map<string, number>): string =>
    items
      .map(
        (it) =>
          `<span class="ov-chip"><i style="background:${it.color}"></i>${it.label}<b>${(counts.get(it.key) ?? 0).toLocaleString()}</b></span>`,
      )
      .join('');
  const pct = cases.length ? Math.round((executed / cases.length) * 100) : 0;
  return `
    <div class="ov-tiles">
      <div class="ov-tile"><b>${totalNodes.toLocaleString()}</b><span>节点总数</span></div>
      <div class="ov-tile"><b>${cases.length.toLocaleString()}</b><span>用例数</span></div>
    </div>
    <div class="ov-group-title">按优先级</div>
    <div class="ov-chips">${chips(PRIORITY_STATS, priority)}</div>
    <div class="ov-group-title">按执行状态</div>
    <div class="ov-chips">${chips(EXEC_STATS, exec)}</div>
    ${cases.length ? `<div class="ov-progress">已执行 ${executed.toLocaleString()} / ${cases.length.toLocaleString()}（${pct}%）</div>` : ''}
  `;
}

/** 数据变化（relayout）后，若概览面板打开则实时刷新 */
function refreshStatsIfOpen(): void {
  if (!statsPopover) return;
  const body = statsPopover.querySelector('#ov-body');
  if (body) body.innerHTML = overviewBodyHtml();
}

function closeStatsPopover(): void {
  statsPopover?.remove();
  statsPopover = null;
  document.getElementById('btn-overview')?.classList.remove('active');
}

function openStatsPopover(): void {
  if (statsPopover) {
    closeStatsPopover();
    return;
  }
  const wrap = document.getElementById('canvas-wrap') as HTMLElement;
  const card = document.createElement('div');
  card.className = 'overview-card';
  card.innerHTML = `
    <div class="ov-header">
      <span class="ov-title">统计概览</span>
      <button class="ov-close" id="stats-close" title="关闭">✕</button>
    </div>
    <div id="ov-body"></div>
  `;
  wrap.appendChild(card);
  statsPopover = card;
  card.querySelector('#ov-body')!.innerHTML = overviewBodyHtml();
  card.querySelector('#stats-close')?.addEventListener('click', closeStatsPopover);
  document.getElementById('btn-overview')?.classList.add('active');
}

// 工具条「概览」按钮 + 顶栏 stats 均可开关统计面板
document.getElementById('btn-overview')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openStatsPopover();
});
document.getElementById('stats')?.addEventListener('click', openStatsPopover);
// 点面板外关闭
window.addEventListener('pointerdown', (e) => {
  if (!statsPopover) return;
  if (statsPopover.contains(e.target as Node)) return;
  const t = e.target as HTMLElement;
  if (t.id === 'stats' || t.closest('#btn-overview')) return;
  closeStatsPopover();
});

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
    const exec = String((n.props as { exec?: string }).exec ?? '');
    // 执行状态：文字 + 彩色胶囊（通过绿 / 阻塞黄 / 失败红）；未执行不展示
    const EXEC_STYLES: Record<string, { label: string; bg: string; border: string; color: string }> = {
      pass: { label: '通过', bg: '#dcfce7', border: '#16a34a', color: '#15803d' },
      blocked: { label: '阻塞', bg: '#fef9c3', border: '#eab308', color: '#a16207' },
      fail: { label: '失败', bg: '#fee2e2', border: '#dc2626', color: '#b91c1c' },
    };
    const execInfo = exec && n.type === 'case' ? EXEC_STYLES[exec] : undefined;
    const execBadge = execInfo
      ? `<span class="o-exec" data-exec="${exec}" title="执行状态：${execInfo.label}" style="display:inline-block;flex-shrink:0;font-size:10px;font-weight:600;line-height:16px;padding:0 6px;border-radius:999px;background:${execInfo.bg};border:1px solid ${execInfo.border};color:${execInfo.color};margin-left:6px;user-select:none">${execInfo.label}</span>`
      : '';
    const selCls = selected?.id === n.id ? 'o-sel' : '';
    return `
      <div class="o-row ${selCls}" data-node="${n.id}" style="margin-left:${depth * 22}px;display:flex;align-items:baseline;gap:2px;padding:3px 6px;border-radius:6px;${selCls ? 'background:#eff6ff' : ''}">
        ${toggle}${iconSpan}${badge}${execBadge}
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
  viewToggleBtn.textContent = outlineMode ? '画布' : '大纲';
  outlinePane.style.display = outlineMode ? 'block' : 'none';
  if (outlineMode) renderOutline();
}

viewToggleBtn.addEventListener('click', toggleOutline);

/**
 * Markdown 快捷前缀解析（幕布式）：
 * '# '→提升为 folder（标题感），'- '或'· '→case 用例，'!'→P0，'!!'→P1…
 * 返回 { type, priority, text }
 */
function parseOutlineShortcut(raw: string, parentIsDim: boolean): { type: string; priority?: string; text: string } {
  let s = raw.trim();
  let type = parentIsDim ? 'folder' : 'case';
  let priority: string | undefined;
  // 前缀标记
  if (/^#\s/.test(s)) { type = 'folder'; s = s.replace(/^#\s/, ''); }
  else if (/^[-·]\s/.test(s)) { type = 'case'; s = s.replace(/^[-·]\s/, ''); }
  // 优先级标记（收尾 !! / !!! 等）
  const bang = s.match(/(!{1,3})$/);
  if (bang) {
    priority = bang[1]!.length === 1 ? 'P0' : bang[1]!.length === 2 ? 'P1' : 'P2';
    s = s.replace(/\s*!{1,3}$/, '');
  }
  return { type, priority, text: s };
}

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

// 折叠切换 + 点击行定位画布（大纲 → 画布同步）
outlinePane.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-toggle]') as HTMLElement | null;
  if (t) {
    const id = t.dataset.toggle!;
    if (outlineCollapsed.has(id)) outlineCollapsed.delete(id);
    else outlineCollapsed.add(id);
    renderOutline();
    return;
  }
  const row = (e.target as HTMLElement).closest('.o-row') as HTMLElement | null;
  if (row && !(e.target as HTMLElement).closest('[data-otext]')) {
    const id = row.dataset.node!;
    if (store.getNode(id)) {
      selectId(id);
      if (!outlineMode) renderer.focusNode(id);
      else renderOutline(); // 高亮大纲当前行
    }
  }
});

// 大纲内结构键：Enter 建同级（MD 快捷前缀），Tab/⇧Tab 缩进/提升，空文本 Enter 删除
outlinePane.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME 组合态
  const span = (e.target as HTMLElement).closest('[data-otext]') as HTMLElement | null;
  if (!span) return;
  const id = span.dataset.otext!;
  const node = store.getNode(id);
  if (!node) return;
  const parent = store.getParent(id);

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const raw = span.textContent?.trim() ?? '';
    if (!raw) {
      // 空行 Enter = 删除该节点（根除外）
      if (id !== store.root.id) {
        snapshot();
        store.deleteSubtree(id);
        renderOutline();
        relayout();
      }
      return;
    }
    // 先提交当前文本（含 MD 前缀快捷：改类型/优先级/文本）
    const parsed = parseOutlineShortcut(raw, String((node.props as { method?: string }).method ?? '') !== '');
    if (parsed.text !== node.text || parsed.type !== node.type) {
      snapshot();
      try {
        if (parsed.type !== node.type) store.setNodeType(id, parsed.type);
        store.updateNode(id, { text: parsed.text, props: { ...(parsed.priority ? { priority: parsed.priority } : {}) } });
      } catch { /* 回滚由 catch 外的渲染兜底 */ }
      renderOutline();
    }
    // 新建同级节点（同样支持输入时用 MD 前缀）
    if (!parent) return;
    snapshot();
    const idx = (parent.children ?? []).findIndex((c) => c.id === id);
    const r = store.addSubtree(parent.id, { type: 'case', text: ' ' });
    store.moveSubtree(r.nodeId, parent.id, idx + 1);
    renderOutline();
    relayout();
    // 聚焦新行
    requestAnimationFrame(() => {
      const ns = outlinePane.querySelector(`[data-otext="${r.nodeId}"]`) as HTMLElement | null;
      ns?.focus();
    });
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const raw = span.textContent?.trim() ?? '';
    if (raw) {
      const parsed = parseOutlineShortcut(raw, false);
      if (parsed.text !== node.text) {
        snapshot();
        store.updateNode(id, { text: parsed.text });
      }
    }
    if (e.shiftKey) {
      outdent(id);
    } else {
      // 缩进：变成前一个兄弟的子节点（幕布行为）
      const siblings = parent?.children ?? [];
      const idx = siblings.findIndex((c) => c.id === id);
      if (idx > 0) {
        const prev = siblings[idx - 1]!;
        if (registry.get(prev.type).leafOnly) {
          toast('上一节点是叶子，不能缩进到它下面', 'warn');
          return;
        }
        snapshot();
        store.moveSubtree(id, prev.id);
        renderOutline();
        relayout();
      }
    }
    requestAnimationFrame(() => {
      (outlinePane.querySelector(`[data-otext="${id}"]`) as HTMLElement | null)?.focus();
    });
  }
});

/** 画布选中变化 → 大纲滚动定位（画布 → 大纲同步） */
function syncOutlineToSelection(): void {
  if (!outlineMode || !selected) return;
  const row = outlinePane.querySelector(`.o-row[data-node="${selected.id}"]`) as HTMLElement | null;
  if (!row) return;
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  outlinePane.querySelectorAll('.o-row.o-sel').forEach((el) => {
    el.classList.remove('o-sel');
    (el as HTMLElement).style.background = '';
  });
  row.classList.add('o-sel');
  row.style.background = '#eff6ff';
}

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

/** 一键全部展开 */
function expandAllNodes(): void {
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
}

/** 一键全部折叠（只留根节点展开） */
function collapseAllNodes(): void {
  expandedIds = new Set([store.root.id]);
  relayout();
  renderer.focusNode(store.root.id);
}

/** 一键默认展开：清除该文档记住的展开状态，按「默认展开层级」重新展开 */
function applyDefaultExpand(): void {
  expandedIds = null;
  if (currentDocId) localStorage.removeItem(LS_EXPANDED + ':' + currentDocId);
  relayout();
  renderer.focusNode(store.root.id);
  toast(`已按默认层级展开（${expandDepthLabel()}）`, 'info');
}

document.getElementById('btn-expand-all')?.addEventListener('click', expandAllNodes);
document.getElementById('btn-collapse-all')?.addEventListener('click', collapseAllNodes);
document.getElementById('btn-default-expand')?.addEventListener('click', applyDefaultExpand);

// ---------- 展开设置（默认展开层级） ----------
const expandMenuEl = document.getElementById('expand-menu') as HTMLDivElement | null;
const expandSettingsBtn = document.getElementById('btn-expand-settings') as HTMLButtonElement | null;
const defaultExpandBtn = document.getElementById('btn-default-expand') as HTMLButtonElement | null;
const EXPAND_DEPTH_OPTIONS: Array<{ key: ExpandDepth; label: string; hint?: string }> = [
  { key: 1, label: '1 层', hint: '仅一级子节点' },
  { key: 2, label: '2 层', hint: '默认' },
  { key: 3, label: '3 层' },
  { key: 'all', label: '全部', hint: '全部展开' },
];

function syncExpandButtons(): void {
  if (defaultExpandBtn) defaultExpandBtn.title = `按默认层级展开（当前：${expandDepthLabel()}）`;
  if (expandSettingsBtn) expandSettingsBtn.title = `展开设置：默认展开层级（当前：${expandDepthLabel()}）`;
}

function hideExpandMenu(): void {
  if (expandMenuEl) expandMenuEl.style.display = 'none';
}

function renderExpandMenu(): void {
  if (!expandMenuEl) return;
  expandMenuEl.innerHTML = `
    <div class="io-group">默认展开层级</div>
    ${EXPAND_DEPTH_OPTIONS.map(
      (o) => `<div class="item" data-expand-depth="${o.key}">
        <span>${o.label}${o.hint ? `<span style="color:#cbd5e1;font-size:11px;margin-left:6px">${o.hint}</span>` : ''}</span>
        <span class="check" style="color:#2563eb;font-weight:700;min-width:12px;text-align:right">${o.key === defaultExpandDepth ? '✓' : ''}</span>
      </div>`,
    ).join('')}
    <div class="divider"></div>
    <div class="io-group">展开操作</div>
    <div class="item" data-expand-action="all"><span>⇱ 全部展开</span></div>
    <div class="item" data-expand-action="collapse"><span>⇲ 全部折叠</span></div>
    <div class="item" data-expand-action="default"><span>⟲ 默认展开</span><span class="kbd">${expandDepthLabel()}</span></div>
  `;
  expandMenuEl.querySelectorAll('[data-expand-depth]').forEach((el) =>
    el.addEventListener('click', () => {
      defaultExpandDepth = normalizeExpandDepth(el.getAttribute('data-expand-depth'));
      localStorage.setItem(EXPAND_DEPTH_KEY, String(defaultExpandDepth));
      // 立即应用：清掉当前文档的自定义展开状态，按新层级重排
      expandedIds = null;
      if (currentDocId) localStorage.removeItem(LS_EXPANDED + ':' + currentDocId);
      relayout();
      renderer.focusNode(store.root.id);
      syncExpandButtons();
      hideExpandMenu();
      toast(`默认展开层级已设为「${expandDepthLabel()}」`, 'success');
    }),
  );
  expandMenuEl.querySelectorAll('[data-expand-action]').forEach((el) =>
    el.addEventListener('click', () => {
      const action = el.getAttribute('data-expand-action');
      hideExpandMenu();
      if (action === 'all') expandAllNodes();
      else if (action === 'collapse') collapseAllNodes();
      else applyDefaultExpand();
    }),
  );
}

function showExpandMenu(): void {
  if (!expandMenuEl || !expandSettingsBtn) return;
  const r = expandSettingsBtn.getBoundingClientRect();
  renderExpandMenu();
  expandMenuEl.style.display = 'block';
  const menuW = expandMenuEl.offsetWidth;
  expandMenuEl.style.top = `${Math.round(r.bottom + 6)}px`;
  expandMenuEl.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - menuW - 8, r.right - menuW)))}px`;
}

expandSettingsBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!expandMenuEl) return;
  if (expandMenuEl.style.display === 'block') hideExpandMenu();
  else showExpandMenu();
});
window.addEventListener('pointerdown', (e) => {
  if (!expandMenuEl || expandMenuEl.style.display !== 'block') return;
  if (expandMenuEl.contains(e.target as Node) || e.target === expandSettingsBtn) return;
  hideExpandMenu();
});
syncExpandButtons();

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
  docLoaded = true;
  store = DocStore.fromJSON(registry, d);
  // doc 引用 store 内部对象：之后所有编辑都反映在 doc 上，persistCurrent/saveLocal 才不会写旧快照
  doc = store.toJSON();
  expandedIds = null;
  selected = null;
  syncDocTitle();
  renderPanel();
  relayout();
  if (!keepViewport) renderer.focusNode(store.root.id);
}

/** 顶栏文件名显示 = 文档标题 */
function syncDocTitle(): void {
  const el = document.getElementById('doc-title');
  if (el) el.textContent = store.document.meta.title || '未命名导图';
}

/** 文件名编辑提交：改名同步到文档 meta 与多文档索引 */
function commitDocTitle(): void {
  const el = document.getElementById('doc-title');
  if (!el) return;
  const next = (el.textContent ?? '').trim();
  syncDocTitle(); // 先复位显示（空/未变时回滚）
  if (!next || next === store.document.meta.title) return;
  store.document.meta.title = next;
  syncDocTitle(); // 显示新标题
  if (currentDocId) touchDocEntry(currentDocId, next);
  saveLocal();
  toast('已重命名', 'success');
}

// 编辑器失焦提交
editorEl().addEventListener('blur', commitEdit);
editorEl().addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME 组合态：Enter/Esc 属于选词/取消候选，不提交
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    editingNodeId = null;
    editorEl().style.display = 'none';
  }
});
// 手动 commitEdit 绑定后 reattach：blur 触发在 display:none 之前调用

// 顶栏文件名编辑（contenteditable）：Enter 提交、Esc 回滚、失焦提交
const docTitleEl = document.getElementById('doc-title') as HTMLSpanElement;
docTitleEl.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME 组合态
  if (e.key === 'Enter') {
    e.preventDefault();
    docTitleEl.blur(); // 触发失焦提交
  } else if (e.key === 'Escape') {
    syncDocTitle();
    docTitleEl.blur();
  }
});
docTitleEl.addEventListener('focus', () => {
  // 聚焦时全选便于整体替换
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(docTitleEl);
  sel?.removeAllRanges();
  sel?.addRange(range);
});
docTitleEl.addEventListener('blur', commitDocTitle);

// 防抖期间关闭页面时立即落盘
window.addEventListener('beforeunload', () => {
  persistExpandedNow();
});

// ---------- 桥接服务（实时协作） ----------
// bridge 地址优先级：localStorage 覆盖 > 构建期注入 > 当前页面主机的 47214 端口。
// 最后一项让同一镜像部署到任意 IP/域名时都不会错误指向访问者自己的 localhost。
const inferredBridgeUrl = `${window.location.protocol}//${window.location.hostname}:47214`;
const BRIDGE_URL = (
  localStorage.getItem('ai-mind-map:bridge') ||
  __AI_MIND_MAP_BRIDGE_URL__?.trim() ||
  inferredBridgeUrl
).replace(/\/$/, '');
/** 按文档记录的最近推送时间（回声抑制，多文档模式下按 remoteId 区分） */
const lastPushAtByRemote = new Map<string, number>();
/** 按文档记录的最近拉取时间：拉取触发的重排不应再回推（否则形成 PUT↔GET 回声循环） */
const lastPullAtByRemote = new Map<string, number>();
/** 按文档记录的远端版本（meta.updatedAt）：PUT 带 If-Match 乐观锁，防止并发写互相覆盖 */
const remoteVersionByRemote = new Map<string, string>();
/** true = bridge 已确认为多文档模式（GET /docs 可用） */
let bridgeMultiDoc = false;

/** 当前打开文档对应的索引条目 */
function currentEntry(): DocEntry | null {
  if (!currentDocId) return null;
  return loadDocsIndex().find((e) => e.id === currentDocId) ?? null;
}

/**
 * 外部（MCP/AI/另一浏览器）改了文档：按 remoteId 重拉全量并刷新视图。
 * docId 缺省时（遗留单文档 bridge）行为同旧版。
 */
async function pullRemote(docId?: string): Promise<void> {
  const entry = currentEntry();
  const rid = docId ?? entry?.remoteId;
  if (rid) {
    const last = lastPushAtByRemote.get(rid) ?? 0;
    if (Date.now() - last < 1500) return; // 自己刚推送过该文档，忽略回声
  } else if (Date.now() - (lastPushAtByRemote.get('#legacy') ?? 0) < 1500) {
    return;
  }
  try {
    const url = rid ? `${BRIDGE_URL}/doc/${encodeURIComponent(rid)}` : `${BRIDGE_URL}/doc`;
    const res = await fetch(url);
    if (!res.ok) return;
    const d = (await res.json()) as MindDocument;
    if (rid) remoteVersionByRemote.set(rid, d.meta.updatedAt ?? ''); // 记录远端版本（If-Match 用）
    if (currentDocId) touchDocEntry(currentDocId, d.meta.title || '未命名导图');
    // 远端替换内容时保留当前视图状态；若涉及节点增删，relayout 会自动过滤失效 id
    const currentExpanded = expandedIds;
    const selectedId = selected?.id;
    // 内容与当前一致（仅 meta.updatedAt 不同）→ 不动视图，也不回推，直接结束
    const sameContent =
      doc.tree === d.tree ||
      (JSON.stringify({ t: doc.tree, a: doc.annotations }) === JSON.stringify({ t: d.tree, a: d.annotations }) &&
        doc.meta.title === d.meta.title);
    lastPullAtByRemote.set(rid ?? '#legacy', Date.now());
    if (sameContent) {
      syncDocTitle();
      return;
    }
    pendingRemoteFill = false; // 远端真实内容已取回（含占位期间的 SSE 变更）：恢复正常保存
    loadDoc(d, true); // keepViewport: 平移缩放不动，只换数据
    expandedIds = currentExpanded;
    relayout();
    if (selectedId) selectId(selectedId);
    syncDocTitle();
  } catch {
    /* bridge 未启动：静默降级为本地模式 */
  }
}

interface BridgeDocsResponse {
  docs: BridgeDocInfo[];
}

/**
 * 把 bridge 的文档列表合并进本地索引（bridge 为权威）：
 * - 按 remoteId 匹配 → 更新标题/时间/节点数
 * - bridge 侧新文档 → 优先与同标题、尚未挂载的本地草稿绑定，否则创建待拉取条目
 * - bridge 侧已删除 → 删除同一文件的本地持久化副本，不得解绑成另一篇文档
 * - 同一 remoteId 只保留一张卡片（优先有本地内容的）
 */
async function syncDocsFromBridge(): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE_URL}/docs`);
    if (!res.ok) return;
    const body = (await res.json()) as BridgeDocsResponse;
    const reconciled = reconcileDocsIndex(loadDocsIndex(), body.docs);
    if (reconciled.changed) {
      for (const id of reconciled.removedLocalIds) {
        localStorage.removeItem(DOC_PREFIX + id);
        localStorage.removeItem(`${LS_EXPANDED}:${id}`);
        if (currentDocId === id) {
          currentDocId = null;
          localStorage.removeItem(LAST_DOC_KEY);
        }
      }
      saveDocsIndex(reconciled.entries);
      // 首页可见时刷新列表
      const home = document.getElementById('home-view');
      if (home && home.style.display !== 'none') renderHome();
    }
  } catch {
    /* bridge 未启动 */
  }
}

/** 探测 bridge 是否多文档模式（GET /docs 200 = 是）。多文档时同步一次列表 */
let lastBridgeDetectAt = 0;

async function detectBridgeMode(): Promise<boolean> {
  const now = Date.now();
  if (now - lastBridgeDetectAt < 5000) return bridgeMultiDoc; // 去抖：5s 内的重复探测直接用缓存
  lastBridgeDetectAt = now;
  try {
    const res = await fetch(`${BRIDGE_URL}/docs`);
    if (!res.ok) return false;
    await syncDocsFromBridge();
    return true;
  } catch {
    return false;
  }
}

/** 启动时尝试连接 bridge 的 SSE（未启动则静默降级） */
function connectBridge(): void {
  try {
    const es = new EventSource(`${BRIDGE_URL}/events`);
    es.addEventListener('hello', () => {
      void detectBridgeMode();
    });
    es.addEventListener('changed', (ev) => {
      // changed 携带 {docId,title,updatedAt}（旧 bridge 为 {}）
      let docId: string | undefined;
      let title = '';
      let changedAt = '';
      try {
        const p = JSON.parse((ev as MessageEvent).data) as { docId?: string; title?: string; updatedAt?: string };
        docId = p.docId;
        title = p.title ?? '';
        changedAt = p.updatedAt ?? '';
      } catch {
        /* 旧负载 */
      }
      if (docId !== undefined && docId !== '' && loadDocsIndex().some((e) => e.remoteId)) {
        // 按文件定点处理：变更事件自带 docId，只有当前打开的那篇才拉内容；
        // 全局列表仅在出现未知 docId（别处新建了文档）时才去重同步一次，
        // 不再为每次变更都拉一遍 /docs
        const entry = loadDocsIndex().find((e) => e.remoteId === docId);
        if (entry) {
          let touched = false;
          if (title && entry.title !== title) {
            entry.title = title;
            touched = true;
          }
          if (changedAt) {
            const t = Date.parse(changedAt);
            if (Number.isFinite(t)) {
              entry.updatedAt = t;
              touched = true;
            }
          }
          if (touched) saveDocsIndex(loadDocsIndex().map((e) => (e.id === entry.id ? entry : e)));
          const cur = currentEntry();
          if (cur?.remoteId && cur.remoteId === docId) schedulePullRemote(docId);
          return;
        }
        scheduleDocsListSync(); // 未知 docId：可能别处新建了文档，去重后同步一次列表
        return;
      }
      // 遗留单文档 bridge 或尚未吸收过文档：保持旧行为
      void pullRemote();
    });
    es.onerror = () => {
      /* 断线自动重连由 EventSource 内建 */
    };
  } catch {
    /* bridge 未启动 */
  }
  void detectBridgeMode(); // 启动时也探测一次（覆盖 SSE 已被缓存/代理的场景）
}

/** 同一文档并发“首次挂载”时复用同一个请求，避免各建一份 bridge 文档 */
const remoteMounts = new Map<string, Promise<string | null>>();

/** 变更事件的按文档去重拉取：Agent 连续 add_subtree 时合并在 400ms 窗口内的多次广播 */
const pendingPulls = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePullRemote(docId: string): void {
  if (pendingPulls.has(docId)) return; // 已有待执行的拉取
  pendingPulls.set(
    docId,
    setTimeout(() => {
      pendingPulls.delete(docId);
      const cur = currentEntry();
      if (cur?.remoteId === docId) void pullRemote(docId);
    }, 400),
  );
}

/** 全局文档列表同步去重：短时间内多次触发只拉一次 */
let docsListSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDocsListSync(): void {
  if (docsListSyncTimer) return;
  docsListSyncTimer = setTimeout(() => {
    docsListSyncTimer = null;
    void syncDocsFromBridge();
  }, 1500);
}

/**
 * 浏览器侧保存：确保指定文档已在 bridge 注册并返回 remoteId。
 * 首次挂载用 `web-<本地文档id>` 作为稳定 id，页面重载/并发保存都不会重复新建文档。
 */
async function ensureRemoteDoc(docId: string, title: string): Promise<string | null> {
  const entry = loadDocsIndex().find((e) => e.id === docId);
  if (!entry) return null; // 索引外的临时文档不推送，避免生成孤儿文档
  if (entry.demo) return null; // 演示文档不自动挂载：避免每个新浏览器/服务器都长出一份演示副本
  if (entry.keepLocalOnly) return null; // 本地专用文档（冲突备份等）：用户显式编辑后才参与同步
  if (entry.remoteId) return entry.remoteId;
  const inflight = remoteMounts.get(docId);
  if (inflight) return inflight;
  const stableId = `web-${docId}`;
  // 先落 remoteId 再请求：即便随后刷新/并发，也不会再新建第二份
  entry.remoteId = stableId;
  saveDocsIndex(loadDocsIndex().map((e) => (e.id === docId ? entry : e)));
  const mount = (async (): Promise<string | null> => {
    try {
      const res = await fetch(`${BRIDGE_URL}/docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, id: stableId }),
      });
      if (!res.ok) {
        rollbackRemoteId(docId, stableId);
        return null;
      }
      const r = (await res.json()) as { id: string; updatedAt?: string };
      if (r.updatedAt) remoteVersionByRemote.set(r.id, r.updatedAt); // 记录新建文档的版本（首次 PUT 的 If-Match）
      if (r.id !== stableId) {
        // 旧版 bridge 不认识指定 id，回填它实际分配的 id
        const cur = loadDocsIndex().find((e) => e.id === docId);
        if (cur) {
          cur.remoteId = r.id;
          saveDocsIndex(loadDocsIndex().map((e) => (e.id === docId ? cur : e)));
        }
      }
      return r.id;
    } catch {
      rollbackRemoteId(docId, stableId);
      return null;
    } finally {
      remoteMounts.delete(docId);
    }
  })();
  remoteMounts.set(docId, mount);
  return mount;
}

/** 首次挂载失败时回滚临时 remoteId（旧版单文件 bridge 会走 /doc 兼容端点） */
function rollbackRemoteId(docId: string, stableId: string): void {
  const cur = loadDocsIndex().find((e) => e.id === docId);
  if (cur && cur.remoteId === stableId) {
    delete cur.remoteId;
    saveDocsIndex(loadDocsIndex().map((e) => (e.id === docId ? cur : e)));
  }
}

/**
 * PUT 收到 409（乐观锁）：文档已被其他浏览器/Agent 写过。
 * 内容一致 → 仅更新版本号（回声）；内容不同 → 先把本地版本备份为独立本地文档，
 * 再加载远端最新内容。绝不静默覆盖他人修改，也不丢自己的修改。
 */
async function handleRemoteConflict(rid: string): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE_URL}/doc/${encodeURIComponent(rid)}`);
    if (!res.ok) return;
    const remote = (await res.json()) as MindDocument;
    lastPullAtByRemote.set(rid, Date.now());
    remoteVersionByRemote.set(rid, remote.meta.updatedAt ?? '');
    const sameContent =
      doc.tree === remote.tree ||
      (JSON.stringify({ t: doc.tree, a: doc.annotations }) ===
        JSON.stringify({ t: remote.tree, a: remote.annotations }) &&
        doc.meta.title === remote.meta.title);
    if (sameContent) {
      syncDocTitle();
      return;
    }
    const backupId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const backupTitle = `${doc.meta.title || '未命名导图'}（冲突备份 ${stamp}）`;
    try {
      localStorage.setItem(DOC_PREFIX + backupId, JSON.stringify(store.toJSON()));
      const entries = loadDocsIndex();
      entries.unshift({ id: backupId, title: backupTitle, updatedAt: Date.now(), keepLocalOnly: true });
      saveDocsIndex(entries);
    } catch {
      /* 存储满：放弃备份也要加载远端最新，避免停留在过期版本上继续编辑 */
    }
    pendingRemoteFill = false;
    loadDoc(remote, true);
    syncDocTitle();
    toast(`远端文档已被他人修改：你的版本已备份为「${backupTitle}」，当前显示远端最新内容`, 'warn');
    const home = document.getElementById('home-view');
    if (home && home.style.display !== 'none') renderHome();
  } catch {
    /* bridge 不可达：保持本地内容，下次保存会再次尝试 */
  }
}

async function pushRemote(): Promise<void> {
  const senderId = currentDocId;
  if (!senderId) return;
  // 占位内容（空白/等待远端填充）绝不推送：曾把演示/空白内容覆盖到真实 bridge 文档上
  if (pendingRemoteFill) return;
  // 演示文档与索引外文档一律不推送：否则会走下面的 /doc 遗留兼容端点，把演示内容写到远端
  const senderEntry = loadDocsIndex().find((e) => e.id === senderId);
  if (!senderEntry || senderEntry.demo) return;
  // 先快照内容与标题：await 期间用户可能切走文档，不能把 B 的内容写进 A 的 bridge 文档
  const payload = JSON.stringify(doc);
  const title = store.document.meta.title || '未命名导图';
  try {
    const rid = await ensureRemoteDoc(senderId, title);
    updateDocUrl(); // 首次挂载后 URL 升级为全局文档 id
    if (rid) {
      // 刚从远端拉取的内容不回推：内容源自 bridge，回推会形成 PUT↔GET 回声循环
      if (Date.now() - (lastPullAtByRemote.get(rid) ?? 0) < 1200) {
        lastPushAtByRemote.set(rid, Date.now()); // 仍抑制本次回声
        return;
      }
      lastPushAtByRemote.set(rid, Date.now());
      // If-Match 乐观锁：版本过期（他人已写入）时服务端返回 409，走冲突处理而不是覆盖
      const version = remoteVersionByRemote.get(rid);
      const res = await fetch(`${BRIDGE_URL}/doc/${encodeURIComponent(rid)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(version ? { 'If-Match': version } : {}),
        },
        body: payload,
      });
      if (res.ok) {
        const r = (await res.json().catch(() => null)) as { updatedAt?: string } | null;
        if (r?.updatedAt) remoteVersionByRemote.set(rid, r.updatedAt);
      } else if (res.status === 409) {
        await handleRemoteConflict(rid);
      } else if (res.status === 404) {
        // 远端文档已被删除：清掉失效 remoteId 并同步列表，避免反复往已删除的 id 写（复活文件）
        const cur = loadDocsIndex().find((e) => e.id === senderId);
        if (cur && cur.remoteId === rid) {
          delete cur.remoteId;
          saveDocsIndex(loadDocsIndex().map((e) => (e.id === senderId ? cur : e)));
        }
        void syncDocsFromBridge();
      }
    } else {
      // 遗留单文档 bridge（POST /docs 400/404）：写 /doc 兼容端点
      lastPushAtByRemote.set('#legacy', Date.now());
      await fetch(`${BRIDGE_URL}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    }
  } catch {
    /* bridge 未启动 */
  }
}

// ---------- 多文档管理 ----------
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

/**
 * 删除文档：先删本地槽位与索引；若已挂到 bridge，再删 bridge 侧文件（--dir 模式），
 * 否则下次同步会把卡片重新拉回来。
 */
async function deleteDoc(id: string): Promise<void> {
  const entry = loadDocsIndex().find((x) => x.id === id);
  localStorage.removeItem(DOC_PREFIX + id);
  saveDocsIndex(loadDocsIndex().filter((x) => x.id !== id));
  if (currentDocId === id) {
    currentDocId = null;
    localStorage.removeItem(LAST_DOC_KEY);
    setDocUrl('', 'replace');
  }
  const rid = entry?.remoteId;
  if (rid) {
    try {
      await fetch(`${BRIDGE_URL}/doc/${encodeURIComponent(rid)}`, { method: 'DELETE' });
    } catch {
      /* bridge 未启动 / 旧 bridge 不支持删除：本地已删，下次同步会再出现，可忽略 */
    }
  }
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

/**
 * 从 bridge 拉取 remoteId 的内容填充当前打开的文档槽位；失败时自动重试一次。
 * 填充成功前 pendingRemoteFill=true：空白占位既不落盘也不推送，
 * 避免把占位内容覆盖到 bridge 上的真实文档。
 */
async function fillRemoteInto(id: string, remoteId: string, allowRetry = true): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE_URL}/doc/${encodeURIComponent(remoteId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = (await res.json()) as MindDocument;
    if (currentDocId !== id) return; // 用户可能已经切走：仅当仍停在本条目时落盘+装载
    pendingRemoteFill = false; // 真实内容已取回：恢复正常落盘/推送
    remoteVersionByRemote.set(remoteId, remote.meta.updatedAt ?? ''); // 记录远端版本（If-Match 用）
    localStorage.setItem(DOC_PREFIX + id, JSON.stringify(remote));
    const idx = loadDocsIndex().find((e) => e.id === id);
    if (idx?.remoteOnly) {
      idx.remoteOnly = false;
      saveDocsIndex(loadDocsIndex().map((e) => (e.id === id ? { ...e, remoteOnly: false } : e)));
    }
    lastPullAtByRemote.set(remoteId, Date.now()); // 内容源自 bridge：抑制紧接着的回推
    loadDoc(remote, false);
    syncDocTitle();
    updateDocUrl(); // 挂载后拿到 remoteId：URL 升级为全局文档 id
  } catch {
    /* bridge 未启动 / 文档已删除：保持空白占位；稍后自动重试一次 */
    if (allowRetry) {
      setTimeout(() => {
        if (currentDocId === id && pendingRemoteFill) void fillRemoteInto(id, remoteId, false);
      }, 3000);
    }
  }
}

// ---------- 文档路由（/d/<bridge 文档 id 或本地 id>，列表为 /） ----------
// 列表页刷新留在列表；编辑页刷新重开原文档；URL 可分享，同事打开即同一篇。
// 优先用 bridge 侧 remoteId（跨浏览器稳定），未挂载的本地草稿退回本地 id。
let lastDocUrlKey: string | null = null;
let docLoaded = false;

function setDocUrl(key: string, mode: 'push' | 'replace'): void {
  try {
    const url = key ? `/d/${encodeURIComponent(key)}` : '/';
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    lastDocUrlKey = key;
  } catch {
    /* 隐私模式等受限场景：忽略，不影响功能 */
  }
}

function updateDocUrl(): void {
  try {
    const home = document.getElementById('home-view');
    if (home && home.style.display !== 'none') return; // 首页 URL 固定为 /
    const entry = currentDocId ? loadDocsIndex().find((x) => x.id === currentDocId) : null;
    const key = entry?.remoteId || currentDocId || '';
    if (lastDocUrlKey === key) return;
    setDocUrl(key, 'replace');
  } catch {
    /* ignore */
  }
}

/** 从 URL 解析文档 key：/d/<id> 或兼容旧链接 ?doc=<id> */
function docKeyFromLocation(): string {
  const m = /^\/d\/([^/]+)\/?$/.exec(location.pathname);
  if (m) return decodeURIComponent(m[1]!);
  return new URLSearchParams(location.search).get('doc') ?? '';
}

/**
 * 按 URL 打开对应视图（启动与 popstate 共用）。
 * - 无 key：显示首页列表（列表刷新留在列表；内存中的文档保留，后退可回）
 * - 有 key：本地条目直接打开；本机没有则从 bridge 拉取建条目（分享链接场景）
 */
function applyRouteFromLocation(): void {
  const key = docKeyFromLocation();
  if (!key) {
    if (!docLoaded) loadDoc(blankDoc('未命名导图'), false);
    showHome(true);
    return;
  }
  const local = loadDocsIndex().find((e) => e.remoteId === key || e.id === key);
  if (local) {
    if (local.id === currentDocId && docLoaded) {
      lastDocUrlKey = key; // 已是该文档：仅对齐 URL，不重复装载
      return;
    }
    openDoc(local.id);
    showHome(false);
    return;
  }
  loadDoc(blankDoc(key), false); // 拉取期间 renderer 的占位内容
  void (async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/doc/${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as MindDocument;
      const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      localStorage.setItem(DOC_PREFIX + id, JSON.stringify(d));
      const entries = loadDocsIndex();
      entries.unshift({ id, title: d.meta.title || '未命名导图', updatedAt: Date.now(), remoteId: key });
      saveDocsIndex(entries);
      remoteVersionByRemote.set(key, d.meta.updatedAt ?? '');
      openDoc(id);
      showHome(false);
    } catch {
      toast('链接指向的文档不存在，或 bridge 暂不可达', 'warn');
      loadDoc(blankDoc('未命名导图'), false);
      showHome(true);
    }
  })();
}

/** 用户主动打开文档：写入一条历史记录（后退可回列表/上一篇） */
function pushDocNav(id: string): void {
  const e = loadDocsIndex().find((x) => x.id === id);
  setDocUrl(e?.remoteId || id, 'push');
}

/** 打开一个文档（从其槽位加载，失效则新建；remoteOnly 条目先从 bridge 拉内容） */
function openDoc(id: string): void {
  const entry = loadDocsIndex().find((e) => e.id === id);
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
  updateDocUrl();
  // 清空撤销栈：history 是全局的，跨文档恢复会把上一篇快照灌进当前文档
  history = [];
  future = [];
  // 槽位为空（remoteOnly / 数据损坏）：装载「空白占位」而不是演示文档。
  // 演示内容一旦被当作占位保存/推送，会把 bridge 上的真实文档覆盖成「订单中心 · 回归测试」。
  pendingRemoteFill = !d;
  loadDoc(d ?? blankDoc(entry?.title || '未命名导图'), false);
  // remoteOnly：内容还在 bridge 侧，异步拉取后刷新
  if (!d && entry?.remoteId) {
    void fillRemoteInto(id, entry.remoteId);
  }
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
function createDoc(title?: string, templateId = 'blank'): string {
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const t = title ?? '未命名导图';
  const d = templateId === 'blank' ? blankDoc(t) : buildTemplateDoc(templateId, t);
  localStorage.setItem(DOC_PREFIX + id, JSON.stringify(d));
  const entries = loadDocsIndex();
  entries.unshift({ id, title: d.meta.title, updatedAt: Date.now() });
  saveDocsIndex(entries);
  localStorage.setItem(LAST_DOC_KEY, id);
  setDocUrl(id, 'push');
  showHome(false); // 先关首页再装载，进入编辑器
  openDoc(id);
  return id;
}

/** 首页条目：list=列表行（文件名 + 行内操作）；card=网格卡片 */
function cardHtml(e: DocEntry): string {
  const initial = (e.title || '?').slice(0, 1);
  const when = e.updatedAt
    ? new Date(e.updatedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  const hues = ['#3b82f6', '#22d3ee', '#4ade80', '#f59e0b', '#f472b6', '#a78bfa', '#34d399'];
  const accent = hues[(e.title || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length]!;
  const nodeCount = e.nodeCount ?? docNodeCount(e.id);

  if (homeViewMode === 'card') {
    return `
    <div class="doc-row" data-id="${e.id}" style="position:relative;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,0.04);transition:transform 0.16s ease,box-shadow 0.16s ease,border-color 0.16s ease"
      onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 10px 28px rgba(15,23,42,0.10)';this.style.borderColor='#bfdbfe'"
      onmouseout="this.style.transform='';this.style.boxShadow='0 1px 3px rgba(15,23,42,0.04)';this.style.borderColor='#e2e8f0'">
      <div style="position:absolute;top:16px;right:16px;width:8px;height:8px;border-radius:50%;background:${accent}"></div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,${accent},${accent}cc);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;flex-shrink:0">${escapeHtml(initial)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14.5px;font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.title)}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px">${when}</div>
        </div>
      </div>
      <div style="font-size:11.5px;color:#64748b;margin-bottom:12px">🗂 ${nodeCount.toLocaleString()} 节点</div>
      <div class="doc-actions" style="display:flex;gap:8px">
        <button class="btn" data-open="${e.id}" style="flex:1;background:#eff6ff;border:1px solid #bfdbfe;color:#2563eb;padding:6px 10px;border-radius:8px;font-size:12.5px">打开</button>
        <button class="btn" data-rename="${e.id}" title="重命名" style="background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:6px 9px;border-radius:8px;font-size:12px">改名</button>
        <button class="btn" data-delete="${e.id}" title="删除" style="background:#fff;border:1px solid #fecaca;color:#dc2626;padding:6px 9px;border-radius:8px;font-size:12px">删除</button>
      </div>
    </div>
  `;
  }

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
      <div class="doc-actions" style="width:158px;flex-shrink:0;display:flex;gap:6px;justify-content:flex-end;align-items:center;opacity:0;transition:opacity 0.14s ease">
        <button class="btn" data-open="${e.id}" style="background:#eff6ff;border:1px solid #bfdbfe;color:#2563eb;padding:5px 12px;border-radius:7px;font-size:12px;white-space:nowrap;flex-shrink:0">打开</button>
        <button class="btn" data-rename="${e.id}" title="重命名" style="background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:5px 8px;border-radius:7px;font-size:12px;white-space:nowrap;flex-shrink:0">改名</button>
        <button class="btn" data-delete="${e.id}" title="删除" style="background:#fff;border:1px solid #fecaca;color:#dc2626;padding:5px 8px;border-radius:7px;font-size:12px;white-space:nowrap;flex-shrink:0">删除</button>
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
// 首页视图模式：list=列表（默认）/ card=卡片网格
type HomeViewMode = 'list' | 'card';
const HOME_VIEW_KEY = 'ai-mind-map:home-view';
let homeViewMode: HomeViewMode = (localStorage.getItem(HOME_VIEW_KEY) as HomeViewMode) || 'list';

function setHomeViewMode(mode: HomeViewMode): void {
  homeViewMode = mode;
  localStorage.setItem(HOME_VIEW_KEY, mode);
  applyHomeViewChrome();
  renderHome();
}

/** 视图模式对应的容器形态与表头显隐、切换按钮高亮 */
function applyHomeViewChrome(): void {
  const grid = document.getElementById('home-grid') as HTMLDivElement;
  const listHead = document.getElementById('home-list-head');
  const btnList = document.getElementById('vm-list');
  const btnCard = document.getElementById('vm-card');
  if (!grid || !btnList || !btnCard) return;
  if (homeViewMode === 'list') {
    grid.style.display = 'flex';
    grid.style.flexDirection = 'column';
    grid.style.gridTemplateColumns = '';
    grid.style.gap = '0';
    if (listHead) listHead.style.display = 'flex';
    btnList.style.background = '#eff6ff';
    btnList.style.color = '#2563eb';
    btnCard.style.background = '#fff';
    btnCard.style.color = '#94a3b8';
  } else {
    grid.style.display = 'grid';
    grid.style.flexDirection = '';
    grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(280px,1fr))';
    grid.style.gap = '18px';
    if (listHead) listHead.style.display = 'none';
    btnCard.style.background = '#eff6ff';
    btnCard.style.color = '#2563eb';
    btnList.style.background = '#fff';
    btnList.style.color = '#94a3b8';
  }
}

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
  applyHomeViewChrome();
  const isEmpty = entries.length === 0;
  const listStyle = homeViewMode === 'list' && !isEmpty;
  grid.style.borderRadius = listStyle ? '12px' : '0';
  grid.style.overflow = listStyle ? 'hidden' : 'visible';
  grid.style.border = listStyle ? '1px solid #e8edf3' : 'none';
  grid.innerHTML =
    isEmpty
      ? `<div style="text-align:center;padding:72px 0;border:1px dashed #cbd5e1;border-radius:14px;background:#fbfdff;margin-top:14px">
           <div style="font-size:34px;margin-bottom:10px">🗺</div>
           <div style="color:#475569;font-size:14px;margin-bottom:6px">还没有导图</div>
           <div style="color:#94a3b8;font-size:12.5px">点击右上角「＋ 新建导图」开始，或导入现有文件</div>
         </div>`
      : entries.map((e) => cardHtml(e)).join('');
  // 行/卡整体可点（打开）；按钮冒泡已由 data-* 分发处理
  grid.querySelectorAll('.doc-row').forEach((el) =>
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return; // 按钮各自处理
      pushDocNav((el as HTMLElement).dataset.id!);
      showHome(false);
      openDoc((el as HTMLElement).dataset.id!);
    }),
  );
  grid.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => {
      pushDocNav((el as HTMLElement).dataset.open!);
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
        void deleteDoc(id).then(() => renderHome());
      }
    }),
  );
}

/** 显示/隐藏首页；离开编辑器前先保存当前文档 */
function showHome(show: boolean): void {
  const home = document.getElementById('home-view') as HTMLDivElement;
  home.style.display = show ? 'block' : 'none';
  if (!show) return;
  closeStatsPopover();
  persistCurrent();
  renderHome();
  // 首页 URL 固定为 /：列表刷新留在列表
  try {
    if (lastDocUrlKey !== '') setDocUrl('', 'replace');
  } catch {
    /* ignore */
  }
}

// 视图切换
document.getElementById('vm-list')?.addEventListener('click', () => setHomeViewMode('list'));
document.getElementById('vm-card')?.addEventListener('click', () => setHomeViewMode('card'));

// 首页按钮
// 新建导图：弹出模板选择对话框
document.getElementById('home-new')?.addEventListener('click', () => {
  openTemplateDialog();
});

// 连接 Agent：MCP/Skill/提示词的获取、复制与下载
document.getElementById('home-connect')?.addEventListener('click', () => {
  void openConnectDialog();
});

interface BridgeConnectInfo {
  bridgeUrl: string;
  mode: 'dir' | 'file';
  target: string;
  /** MCP Streamable HTTP 端点（远程接入，复制即用） */
  mcpUrl?: string;
  mcpHttpJson?: { mcpServers: Record<string, { type: 'http'; url: string }> };
  mcpJson: { mcpServers: Record<string, { command: string; args: string[] }> };
}

/** Agent 接入对话框：从 bridge /connect 拉真实配置；bridge 离线时降级为占位模板 */
async function openConnectDialog(): Promise<void> {
  let info: BridgeConnectInfo | null = null;
  try {
    const res = await fetch(`${BRIDGE_URL}/connect`);
    if (res.ok) info = (await res.json()) as BridgeConnectInfo;
  } catch {
    /* bridge 未启动 */
  }

  // MCP 配置：远程 HTTP（复制即用，无需本地安装仓库）与本地 stdio（同机）两种变体
  const mcpUrl = info?.mcpUrl ?? `${BRIDGE_URL}/mcp`;
  const mcpHttpText = info?.mcpHttpJson
    ? JSON.stringify(info.mcpHttpJson, null, 2)
    : JSON.stringify({ mcpServers: { 'ai-mind-map': { type: 'http', url: mcpUrl } } }, null, 2);
  const mcpConfigText = info
    ? JSON.stringify(info.mcpJson, null, 2)
    : JSON.stringify(
        {
          mcpServers: {
            'ai-mind-map': {
              command: 'npx',
              args: ['-y', 'tsx', '<仓库绝对路径>/packages/mcp-server/src/cli.ts', '--dir', '/path/to/mindmaps'],
            },
          },
        },
        null,
        2,
      );

  const skillText = __AI_MIND_MAP_SKILL__;

  const chatHint = `我在用 ai-mind-map 管理测试用例脑图（MCP 已连接）。
请读取 <方案文档或代码目录>，然后：
1. 先 list_documents 看现有文档；
2. 用 create_document 新建一篇脑图（标题 = 方案名），保存返回的 id；
3. 后续 query_tree / get_test_methods / add_subtree / validate_document 每次都显式传这个 docId，按「模块 → 小节 → 用例」挂载，用例 props 带 priority / expected / remark（来源引用）。
不要动我已有的脑图文档。`;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:1500;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px 26px;width:680px;max-width:94vw;max-height:88vh;overflow-y:auto;box-shadow:0 24px 80px rgba(15,23,42,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:17px;font-weight:700;color:#1e293b">连接 Agent</div>
        <button id="conn-close" style="border:none;background:transparent;cursor:pointer;color:#94a3b8;font-size:15px">✕</button>
      </div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:14px">
        ${info
          ? `bridge 在线 · ${info.mode === 'dir' ? `多文档模式（${escapeHtml(info.target)}）` : '单文档模式'} · ${escapeHtml(info.bridgeUrl)}`
          : `<b style="color:#b45309">bridge 未连接</b> · 显示的是模板配置。先 <code>make bridge</code> 启动后刷新本页可获取填好真实路径的配置`}
      </div>

      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b style="font-size:13.5px;color:#1e293b">① MCP 接入</b>
          <span style="display:flex;gap:6px">
            <button class="btn conn-copy" data-copy="mcpHttp" style="padding:4px 12px;font-size:12px">复制远程配置</button>
            <button class="btn conn-dl" data-dl="mcp" style="padding:4px 12px;font-size:12px">下载 .mcp.json</button>
          </span>
        </div>
        <div style="font-size:11.5px;color:#64748b;margin-bottom:8px">
          <b style="color:#15803d">推荐：远程 HTTP</b>（无需本地安装仓库，复制后粘到
          <code>.mcp.json</code> / Claude Desktop / Codex 配置，重启客户端即可用）：
        </div>
        <pre id="conn-mcp-http" style="background:#0f172a;color:#e2e8f0;border-radius:9px;padding:12px;font-size:11.5px;line-height:1.55;overflow-x:auto;margin:0 0 8px;white-space:pre">${escapeHtml(mcpHttpText)}</pre>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <code id="conn-mcp-url" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:3px 8px;font-size:11.5px;color:#475569">${escapeHtml(mcpUrl)}</code>
          <button class="btn conn-copy" data-copy="mcpUrl" style="padding:3px 10px;font-size:11.5px">复制 URL</button>
          <span style="font-size:11px;color:#94a3b8">Codex / Cursor 亦支持该 URL 方式接入</span>
        </div>
        <details>
          <summary style="cursor:pointer;font-size:11.5px;color:#64748b;user-select:none">本地 stdio 方式（Agent 与 bridge 同机时使用）</summary>
          <div style="font-size:11.5px;color:#64748b;margin:6px 0 6px">
            放到项目 <code>.mcp.json</code>（Claude Code）或 Claude Desktop 的
            <code>claude_desktop_config.json</code>，重启后 Agent 即可管理你的脑图。
          </div>
          <pre id="conn-mcp" style="background:#0f172a;color:#e2e8f0;border-radius:9px;padding:12px;font-size:11.5px;line-height:1.55;overflow-x:auto;margin:0;white-space:pre">${escapeHtml(mcpConfigText)}</pre>
        </details>
      </div>

      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b style="font-size:13.5px;color:#1e293b">② Skill（团队复用）</b>
          <span style="display:flex;gap:6px">
            <button class="btn conn-copy" data-copy="skill" style="padding:4px 12px;font-size:12px">复制 Skill</button>
            <button class="btn conn-dl" data-dl="skill" style="padding:4px 12px;font-size:12px">下载 SKILL.md</button>
          </span>
        </div>
        <div style="font-size:11.5px;color:#64748b;margin-bottom:6px">
          复制或下载的内容与仓库最新
          <code>.agents/skills/test-case-designer/SKILL.md</code> 一致；完整使用时请同时保留该目录下的
          <code>references/</code> 与 <code>scripts/</code>。
        </div>
        <pre id="conn-skill" style="display:none">${escapeHtml(skillText)}</pre>
        <div style="font-size:11.5px;color:#94a3b8">内容已就绪：点上方按钮复制或下载（不占弹窗空间）</div>
      </div>

      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b style="font-size:13.5px;color:#1e293b">③ 直接对话提示词</b>
          <button class="btn conn-copy" data-copy="chat" style="padding:4px 12px;font-size:12px">复制提示词</button>
        </div>
        <div style="font-size:11.5px;color:#64748b;margin-bottom:6px">
          已接入 MCP 的 Agent 里直接粘贴；配合应用内「✦ AI 助手」抽屉也可用（bridge 在线时）。
        </div>
        <pre id="conn-chat" style="display:none">${escapeHtml(chatHint)}</pre>
        <div style="font-size:11.5px;color:#94a3b8">内容已就绪：点上方按钮复制</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = (): void => overlay.remove();
  overlay.querySelector('#conn-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const payload = (): Record<string, string> => ({
    mcpHttp: mcpHttpText,
    mcpUrl,
    mcp: mcpConfigText,
    skill: skillText,
    chat: chatHint,
  });
  const copyLabel: Record<string, string> = {
    mcpHttp: '复制远程配置',
    mcpUrl: '复制 URL',
    mcp: '复制本地配置',
    skill: '复制 Skill',
    chat: '复制提示词',
  };
  overlay.querySelectorAll('.conn-copy').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = (btn as HTMLElement).dataset.copy!;
      const copied = await copyText(payload()[key]!, (copyLabel[key] ?? '内容').replace(/^复制/, ''));
      if (copied) {
        btn.textContent = '已复制 ✓';
        setTimeout(() => (btn.textContent = copyLabel[key] ?? '复制'), 1400);
      }
    }),
  );
  overlay.querySelectorAll('.conn-dl').forEach((btn) =>
    btn.addEventListener('click', () => {
      const key = (btn as HTMLElement).dataset.dl!;
      if (key === 'mcp') download('.mcp.json', mcpHttpText, 'application/json');
      else if (key === 'skill') download('SKILL.md', skillText, 'text/markdown');
    }),
  );
}

/** 模板选择对话框：名称 + 模板卡片，确认后创建 */
function openTemplateDialog(): void {
  const tpl = BUILTIN_TEMPLATES;
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:1500;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px 28px;width:620px;max-width:92vw;box-shadow:0 24px 80px rgba(15,23,42,0.3)">
      <div style="font-size:17px;font-weight:700;color:#1e293b;margin-bottom:4px">新建导图</div>
      <div style="font-size:12.5px;color:#94a3b8;margin-bottom:18px">选择一个模板开始；根节点名称将默认使用导图名称</div>
      <div style="margin-bottom:18px">
        <input id="tpl-name" placeholder="导图名称" style="width:100%;font-size:14px;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;outline:none;box-sizing:border-box" />
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-bottom:20px">
        ${tpl
          .map(
            (t, i) => `
          <div class="tpl-card" data-id="${t.id}" style="border:1.5px solid ${i === 0 ? '#2563eb' : '#e2e8f0'};border-radius:12px;padding:14px;cursor:pointer;transition:border-color 0.14s ease,background 0.14s ease;${i === 0 ? 'background:#f5f8ff;' : ''}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:14px;font-weight:600;color:#1e293b">${t.name}</span>
              ${t.tags.map((tag) => `<span style="font-size:10px;color:#2563eb;background:#eff6ff;border-radius:999px;padding:1px 8px">${tag}</span>`).join('')}
            </div>
            <div style="font-size:12px;color:#64748b;line-height:1.5">${t.description}</div>
          </div>`,
          )
          .join('')}
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button class="btn" id="tpl-cancel" style="padding:8px 18px">取消</button>
        <button class="btn primary" id="tpl-ok" style="padding:8px 18px">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  let selected = tpl[0]!.id;
  const nameInput = overlay.querySelector('#tpl-name') as HTMLInputElement;
  (overlay.querySelector('.tpl-card') as HTMLElement).style.borderColor = '#2563eb';
  overlay.querySelectorAll('.tpl-card').forEach((card) => {
    card.addEventListener('click', () => {
      selected = (card as HTMLElement).dataset.id!;
      overlay.querySelectorAll('.tpl-card').forEach((c) => {
        (c as HTMLElement).style.borderColor = '#e2e8f0';
        (c as HTMLElement).style.background = '#fff';
      });
      (card as HTMLElement).style.borderColor = '#2563eb';
      (card as HTMLElement).style.background = '#f5f8ff';
    });
  });
  const close = (): void => overlay.remove();
  overlay.querySelector('#tpl-cancel')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('#tpl-ok')?.addEventListener('click', () => {
    const title = nameInput.value.trim() || '未命名导图';
    close();
    createDoc(title, selected);
  });
  nameInput.focus();
}
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
        setDocUrl(id, 'push');
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
  setDocUrl('', 'push');
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

// 旧版首次使用会预置演示文档（demo 标记）。演示文档已按需求彻底移除；
// 这里清理浏览器 localStorage 里残留的演示内容，两类都清：
// ① demo 标记且仍是演示原标题的条目；② 内容指纹命中演示数据的条目（历史污染镜像、
//    冲突备份等——标题含「订单中心 · 回归测试」且 root 文本为「根节点」且节点数 ≥ 12000）。
// 用户若在演示基础上改名/重建过真实内容则不会被指纹命中，予以保留。
(function purgeDemoDocs(): void {
  const count = (n: { children?: unknown[] }): number =>
    1 + (n.children ?? []).reduce((acc: number, c) => acc + count(c as { children?: unknown[] }), 0);
  const staleIds: string[] = [];
  for (const e of loadDocsIndex()) {
    if (e.demo && e.title === DEMO_TITLE) {
      staleIds.push(e.id);
      continue;
    }
    const raw = localStorage.getItem(DOC_PREFIX + e.id);
    if (!raw) continue;
    try {
      const d = JSON.parse(raw) as MindDocument;
      if (!(d.meta?.title ?? '').includes(DEMO_TITLE)) continue;
      if (d.tree?.text !== '根节点') continue;
      if (count(d.tree) < 12000) continue;
      staleIds.push(e.id);
    } catch {
      /* 槽位解析失败不动，避免误删 */
    }
  }
  if (!staleIds.length) return;
  for (const id of staleIds) {
    localStorage.removeItem(DOC_PREFIX + id);
    localStorage.removeItem(`${LS_EXPANDED}:${id}`);
  }
  saveDocsIndex(loadDocsIndex().filter((e) => !staleIds.includes(e.id)));
  if (staleIds.includes(localStorage.getItem(LAST_DOC_KEY) ?? '')) {
    localStorage.removeItem(LAST_DOC_KEY);
    currentDocId = null;
  }
})();

// 启动与前进/后退共用一套路由：/ → 首页列表；/d/<id> → 打开该文档
window.addEventListener('popstate', () => applyRouteFromLocation());
applyRouteFromLocation();
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
    // 当前文档先确保已在 bridge 注册并同步内容；AI 会话默认作用于当前文档（docId 定向）
    await pushRemote();
    const rid = currentDocId ? (loadDocsIndex().find((e) => e.id === currentDocId)?.remoteId ?? null) : null;
    const res = await fetch(`${BRIDGE_URL}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rid ? { message, docId: rid } : { message }),
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
  if (e.isComposing || e.keyCode === 229) return; // IME 组合态
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendAiMessage();
  }
});

