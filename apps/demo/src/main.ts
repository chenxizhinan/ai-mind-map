/**
 * Demo 应用：万级节点渲染 + 侧边面板（用例信息 / 批注两个页签）。
 *
 * 数据流：DocStore（内存）→ layoutTree → renderer.setData。
 * MCP server 写入的 JSON 文件可在「加载文件」时导入（见页面右上按钮）。
 */
import {
  DocStore,
  NodeTypeRegistry,
  layoutTree,
  registerBuiltinTypes,
  type FlatNode,
  type MindNode,
} from '@ai-mind-map/core';
import { MindRenderer } from '@ai-mind-map/renderer';

const registry = new NodeTypeRegistry();
registerBuiltinTypes(registry);

// ---------- 演示数据（约 12k 节点） ----------
function generateDemoData(folderCount = 120, casePerFolder = 100): DocStore {
  const store = new DocStore(registry, {
    meta: { title: '订单中心 · 回归测试', updatedAt: new Date().toISOString() },
  });
  const modules = ['创建订单', '支付', '退款', '发货', '售后', '优惠券', '库存', '物流', '发票', '地址'];
  const priorities = ['P0', 'P1', 'P2', 'P3'] as const;
  for (let i = 0; i < folderCount; i++) {
    const mod = modules[i % modules.length];
    const cases = Array.from({ length: casePerFolder }, (_, j) => ({
      type: 'case',
      text: `${mod}场景${j + 1}：常规流程验证`,
      props: {
        priority: priorities[j % 4],
        precondition: '用户已登录，购物车非空',
        steps: ['进入页面', '填写必要字段', '提交'],
        expected: '状态流转正确，结果可查询',
      },
    }));
    store.addSubtree(store.root.id, {
      type: 'folder',
      text: `${mod}-${String(i).padStart(3, '0')}`,
      children: cases,
    });
  }
  return store;
}

// ---------- 状态 ----------
let store: DocStore = generateDemoData();
let selected: FlatNode | null = null;
/** 折叠状态唯一来源：显式展开集合；null = 用默认深度 */
let expandedIds: Set<string> | null = null;

const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new MindRenderer(canvasEl, {
  onSelect: (n) => {
    selected = n;
    renderPanel();
  },
  onToggleCollapse: (n) => {
    if (!expandedIds) {
      // 从默认深度状态切换到显式集合：以当前可见性初始化
      expandedIds = collectDefaultExpanded(2);
    }
    if (expandedIds?.has(n.id)) {
      expandedIds.delete(n.id);
    } else {
      expandedIds!.add(n.id);
    }
    relayout();
    renderer.focusNode(n.id);
  },
});
canvasEl.addEventListener('dblclick', (e) => {
  const rect = canvasEl.getBoundingClientRect();
  const hit = renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (hit && hit.zone === 'body') startEdit(hit.node);
});

/** 收集默认深度下展开的节点 id（进入显式折叠模式前的快照） */
function collectDefaultExpanded(depth: number): Set<string> {
  const set = new Set<string>();
  const walk = (n: MindNode, d: number): void => {
    if (d < depth) {
      set.add(n.id);
      for (const c of n.children ?? []) walk(c, d + 1);
    }
  };
  walk(store.root, 0);
  return set;
}

// ---------- 布局与统计 ----------
function relayout(): void {
  const flat = layoutTree(store.root, registry, {
    defaultExpandDepth: 2,
    expandedIds: expandedIds ?? undefined,
  });
  const counts = new Map<string, number>();
  for (const a of store.document.annotations) {
    if (a.status !== 'open') continue;
    counts.set(a.nodeId, (counts.get(a.nodeId) ?? 0) + 1);
  }
  renderer.setData(flat, counts);
  const total = countNodes(store.root);
  document.getElementById('stats')!.textContent =
    `${total.toLocaleString()} 节点 · ${store.document.annotations.filter((a) => a.status === 'open').length} 未解决批注`;
}

function countNodes(n: MindNode): number {
  return 1 + (n.children ?? []).reduce((acc, c) => acc + countNodes(c), 0);
}

// ---------- 侧边面板 ----------
const aside = document.getElementById('panel') as HTMLElement;
let panelTab: 'info' | 'anns' = 'info';

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
    aside.innerHTML = '<div style="margin:auto;color:#94a3b8;font-size:13px">选中节点查看详情<br/><span style="font-size:11px">双击编辑文本 · 滚轮平移 · Ctrl+滚轮缩放</span></div>';
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
          <button class="btn" id="btn-add-folder">+ 子路径</button>
          <button class="btn" id="btn-add-case">+ 用例</button>
        </div>
      </div>
    `;
    document.getElementById('btn-save-folder')?.addEventListener('click', () => {
      store.updateNode(node.id, {
        props: { note: (document.getElementById('f-note') as HTMLTextAreaElement).value.trim() || undefined },
      });
    });
    document.getElementById('btn-add-folder')?.addEventListener('click', () => {
      store.addSubtree(node.id, { type: 'folder', text: '新路径' });
      relayout();
    });
    document.getElementById('btn-add-case')?.addEventListener('click', () => {
      store.addSubtree(node.id, { type: 'case', text: '新用例', props: { priority: 'P2' } });
      relayout();
    });
  }
}

function renderAnnotations(body: HTMLElement, node: MindNode): void {
  const anns = store.listAnnotations(node.id);
  body.innerHTML =
    (anns.length
      ? anns.map(threadHtml).join('')
      : '<div style="color:#94a3b8;font-size:12px;margin-bottom:12px">该节点暂无批注</div>') +
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
    store.addAnnotation(node.id, ta.value.trim(), 'user');
    relayout();
    renderPanel();
  });
  body.querySelectorAll('[data-resolved]').forEach((btn) =>
    btn.addEventListener('click', () => {
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
        store.replyAnnotation(id, box.value.trim(), 'user');
        relayout();
        renderPanel();
      }
    }),
  );
}

function threadHtml(a: {
  id: string;
  nodeId: string;
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

// ---------- DOM overlay 文本编辑 ----------
const editor = document.getElementById('node-editor') as HTMLDivElement;
let editingId: string | null = null;

function startEdit(node: FlatNode): void {
  editingId = node.id;
  const r = renderer.nodeScreenRect(node);
  editor.style.display = 'block';
  editor.style.left = `${r.left}px`;
  editor.style.top = `${r.top}px`;
  editor.style.width = `${Math.max(140, r.width)}px`;
  editor.style.height = `${r.height}px`;
  editor.textContent = node.text;
  editor.focus();
  document.getSelection()?.selectAllChildren(editor);
}

function commitEdit(): void {
  if (!editingId) return;
  const text = editor.textContent?.trim();
  editor.style.display = 'none';
  const id = editingId;
  editingId = null;
  if (text && text !== store.getNode(id)?.text) {
    store.updateNode(id, { text });
    relayout();
  }
}

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    editingId = null;
    editor.style.display = 'none';
  }
});
editor.addEventListener('blur', commitEdit);

// ---------- 工具条 ----------
document.getElementById('btn-expand-all')?.addEventListener('click', () => {
  // 全部展开：把所有有子节点的节点都放进显式集合
  const all = new Set<string>();
  const walk = (n: MindNode): void => {
    if (n.children?.length) {
      all.add(n.id);
      for (const c of n.children) walk(c);
    }
  };
  walk(store.root);
  expandedIds = all;
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
    alert('用例节点不能再添加子节点');
    return;
  }
  store.addSubtree(node.id, { type: 'case', text: '新用例', props: { priority: 'P2' } });
  relayout();
});
document.getElementById('load-file')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    f.text().then((t) => {
      try {
        store = DocStore.fromJSON(registry, JSON.parse(t));
        selected = null;
        expandedIds = null;
        document.getElementById('doc-title')!.textContent = store.document.meta.title;
        relayout();
        renderPanel();
      } catch (e) {
        alert(`加载失败：${(e as Error).message}`);
      }
    });
  };
  input.click();
});

// ---------- 启动 ----------
relayout();
document.getElementById('doc-title')!.textContent = store.document.meta.title;
renderer.focusNode(store.root.id);
// 暴露给自动化测试 / 控制台调试
(window as unknown as Record<string, unknown>).renderer = renderer;
(window as unknown as Record<string, unknown>).store = store;
