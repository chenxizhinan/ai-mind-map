/**
 * 多文档管理：bridge / stdio MCP 共用的文档上下文。
 *
 * - DirDocManager：--dir 模式，目录下每个 *.mindmap.json 是一篇文档，
 *   id = 文件名去扩展名；懒加载 + mtime 扫描（外部增/改/删）。
 * - singleDocContext：--file 单文档模式的兼容适配（id 恒为 'default'，
 *   createDoc 明确报错引导用 --dir）。
 *
 * 所有写入经 save() 落盘（store.ts），与单文件模式同一套校验。
 */
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { DocStore, NodeTypeRegistry } from '@ai-mind-map/core';
import { save } from './store.js';

export interface DocSummary {
  id: string;
  title: string;
  updatedAt: string;
  nodeCount: number;
  active: boolean;
}

export interface DocContext {
  /** 当前激活文档（现有全部节点工具作用于它） */
  store(): DocStore;
  /** 持久化激活文档（写它自己的文件） */
  persist(): void;
  listDocs(): DocSummary[];
  /** 切换激活文档。id/title 二选一；重名抛错并列出候选 id */
  openDoc(ref: { id?: string; title?: string }): { id: string; title: string; rootId: string };
  /** 新建文档并激活。单文件模式抛错 */
  createDoc(input: { title: string }): { id: string; title: string; rootId: string };
  /** 按 id 取文档（bridge /doc/:id 路由用）；不存在返回 undefined */
  byId(id: string): DocStore | undefined;
  /** 按 id 替换文档内容（PUT /doc/:id）；--dir 模式未知 id 自建文件。返回 docId */
  putDoc(id: string, raw: unknown): string;
}

interface Slot {
  store: DocStore;
  filePath: string;
}

/** 文件名 slug：保留 CJK/字母/数字/-_，其余折叠为 -；空则 untitled */
export function slugifyTitle(title: string): string {
  const s = title
    .replace(/[/\\<>:"|?*\x00-\x1f]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return s || 'untitled';
}

/** id 合法性（防路径穿越）：仅允许字母数字 CJK - _ . */
export function isValidDocId(id: string): boolean {
  return id.length > 0 && id.length <= 120 && !/[/\\<>:"|?*\x00-\x1f]/.test(id) && id !== '.' && id !== '..';
}

function countNodes(n: { children?: unknown[] }): number {
  let c = 1;
  for (const k of (n.children ?? []) as { children?: unknown[] }[]) c += countNodes(k);
  return c;
}

/** 新建一篇空文档（根文本 = 标题） */
export function createEmptyStore(registry: NodeTypeRegistry, title: string): DocStore {
  const s = new DocStore(registry, {
    meta: { title, updatedAt: new Date().toISOString() },
  });
  s.updateNode(s.root.id, { text: title });
  return s;
}

export class DirDocManager implements DocContext {
  private slots = new Map<string, Slot>();
  private activeId: string | null = null;
  private dirty = new Set<string>();
  /** 上次扫描的文件 mtime 快照：path → mtimeMs */
  private known = new Map<string, number>();

  constructor(
    private registry: NodeTypeRegistry,
    private dirPath: string,
  ) {}

  get dir(): string {
    return resolve(this.dirPath);
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id}.mindmap.json`);
  }

  private loadSlot(id: string): Slot | undefined {
    if (this.slots.has(id)) return this.slots.get(id);
    const fp = this.fileOf(id);
    if (!existsSync(fp)) return undefined;
    const store = DocStore.fromJSON(this.registry, JSON.parse(readFileSync(fp, 'utf8')));
    const slot = { store, filePath: fp };
    this.slots.set(id, slot);
    return slot;
  }

  /** 确保有激活文档：优先最近修改的文件，否则建一篇「未命名导图」 */
  ensureActive(): string {
    if (this.activeId && this.slots.has(this.activeId)) return this.activeId;
    const scan = this.scanFiles();
    if (scan.length) {
      this.activeId = scan[0]!.id;
      return this.activeId;
    }
    const r = this.createDoc({ title: '未命名导图' });
    return r.id;
  }

  private scanFiles(): Array<{ id: string; mtime: number }> {
    if (!existsSync(this.dir)) return [];
    const out: Array<{ id: string; mtime: number }> = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.mindmap.json')) continue;
      const fp = join(this.dir, f);
      try {
        out.push({ id: basename(f, '.mindmap.json'), mtime: statSync(fp).mtimeMs });
      } catch {
        /* 并发删除 */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  store(): DocStore {
    const id = this.ensureActive();
    const slot = this.loadSlot(id);
    if (!slot) throw new Error(`active doc missing: ${id}`);
    return slot.store;
  }

  persist(): void {
    if (!this.activeId) return;
    const slot = this.loadSlot(this.activeId);
    if (!slot) return;
    save(slot.store, slot.filePath);
    this.dirty.add(this.activeId);
    this.known.set(this.fileOf(this.activeId), statSync(slot.filePath).mtimeMs);
  }

  listDocs(): DocSummary[] {
    const files = this.scanFiles();
    // 已在内存但尚未落盘过的新建文档也要列出
    const ids = new Set<string>([...files.map((f) => f.id), ...this.slots.keys()]);
    const out: DocSummary[] = [];
    for (const id of ids) {
      const slot = this.loadSlot(id);
      let title = id;
      let updatedAt = '';
      let nodeCount = 1;
      if (slot) {
        title = slot.store.document.meta.title || id;
        updatedAt = slot.store.document.meta.updatedAt;
        nodeCount = countNodes(slot.store.toJSON().tree);
      }
      out.push({ id, title, updatedAt, nodeCount, active: id === this.activeId });
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  openDoc(ref: { id?: string; title?: string }): { id: string; title: string; rootId: string } {
    if (ref.id) {
      if (!isValidDocId(ref.id)) throw new Error(`非法文档 id: ${ref.id}`);
      const slot = this.loadSlot(ref.id);
      if (!slot) throw new Error(`文档不存在: ${ref.id}`);
      this.activeId = ref.id;
      return { id: ref.id, title: slot.store.document.meta.title, rootId: slot.store.root.id };
    }
    if (ref.title) {
      const all = this.listDocs();
      const exact = all.filter((d) => d.title === ref.title);
      if (exact.length === 1) return this.openDoc({ id: exact[0]!.id });
      if (exact.length > 1) {
        throw new Error(`标题「${ref.title}」匹配到多篇文档，请用 id 指定: ${exact.map((d) => d.id).join(', ')}`);
      }
      // 唯一模糊匹配（大小写不敏感包含）
      const t = ref.title.toLowerCase();
      const fuzzy = all.filter((d) => d.title.toLowerCase().includes(t));
      if (fuzzy.length === 1) return this.openDoc({ id: fuzzy[0]!.id });
      if (fuzzy.length > 1) {
        throw new Error(`标题「${ref.title}」模糊匹配到多篇文档，请用 id 指定: ${fuzzy.map((d) => d.id).join(', ')}`);
      }
      throw new Error(`找不到文档「${ref.title}」。可用文档: ${all.map((d) => d.title).join('、') || '（空）'}`);
    }
    throw new Error('open_document 需要 id 或 title 之一');
  }

  createDoc(input: { title: string }): { id: string; title: string; rootId: string } {
    const title = input.title.trim() || '未命名导图';
    const base = slugifyTitle(title);
    let id = base;
    let n = 2;
    while (existsSync(this.fileOf(id)) || this.slots.has(id)) {
      id = `${base}-${n++}`;
    }
    const store = createEmptyStore(this.registry, title);
    const fp = this.fileOf(id);
    save(store, fp);
    const slot = { store, filePath: fp };
    this.slots.set(id, slot);
    this.activeId = id;
    this.dirty.add(id);
    this.known.set(fp, statSync(fp).mtimeMs);
    return { id, title, rootId: store.root.id };
  }

  byId(id: string): DocStore | undefined {
    if (!isValidDocId(id)) return undefined;
    return this.loadSlot(id)?.store;
  }

  putDoc(id: string, raw: unknown): string {
    if (!isValidDocId(id)) throw new Error(`非法文档 id: ${id}`);
    const store = DocStore.fromJSON(this.registry, raw);
    const fp = this.fileOf(id);
    save(store, fp);
    this.slots.set(id, { store, filePath: fp });
    this.activeId = id;
    this.dirty.add(id);
    this.known.set(fp, statSync(fp).mtimeMs);
    return id;
  }

  /** 目录扫描：返回相对上次快照的增/改/删（bridge 轮询调用） */
  scanForChanges(): { added: string[]; changed: string[]; removed: string[] } {
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    const seen = new Map<string, number>();
    if (existsSync(this.dir)) {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.mindmap.json')) continue;
        const fp = join(this.dir, f);
        const id = basename(f, '.mindmap.json');
        try {
          const m = statSync(fp).mtimeMs;
          seen.set(id, m);
          const prev = this.known.get(id);
          if (prev === undefined) {
            added.push(id);
          } else if (prev !== m) {
            changed.push(id);
            // 外部改过：丢弃内存副本，下次按 id 重载
            this.slots.delete(id);
          }
          this.known.set(id, m);
        } catch {
          /* 并发删除 */
        }
      }
    }
    for (const id of this.known.keys()) {
      if (!seen.has(id)) {
        removed.push(id);
        this.known.delete(id);
        this.slots.delete(id);
        if (this.activeId === id) this.activeId = null;
      }
    }
    return { added, changed, removed };
  }

  /** AI 循环等写入后，取本次会话弄脏的 docId 集合（供 broadcast） */
  takeDirty(): string[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }
}

/** --file 单文档模式的兼容上下文 */
export class SingleDocContext implements DocContext {
  constructor(
    private registry: NodeTypeRegistry,
    private filePath: string,
    private getStore: () => DocStore,
    private setStore: (s: DocStore) => void,
  ) {}

  store(): DocStore {
    return this.getStore();
  }

  persist(): void {
    save(this.getStore(), this.filePath);
  }

  listDocs(): DocSummary[] {
    const s = this.getStore();
    return [
      {
        id: 'default',
        title: s.document.meta.title,
        updatedAt: s.document.meta.updatedAt,
        nodeCount: countNodes(s.toJSON().tree),
        active: true,
      },
    ];
  }

  openDoc(ref: { id?: string; title?: string }): { id: string; title: string; rootId: string } {
    const s = this.getStore();
    if (ref.id && ref.id !== 'default') throw new Error(`单文件模式只有一篇文档（id=default），请用 --dir 启动多文档模式`);
    if (ref.title && ref.title !== s.document.meta.title) {
      throw new Error(`找不到文档「${ref.title}」（单文件模式只有「${s.document.meta.title}」）`);
    }
    return { id: 'default', title: s.document.meta.title, rootId: s.root.id };
  }

  createDoc(_input: { title: string }): { id: string; title: string; rootId: string } {
    throw new Error('单文件模式不支持新建文档。请用 --dir 启动多文档模式（bridge-cli.ts --dir ./mindmaps）');
  }

  byId(_id: string): DocStore | undefined {
    return this.getStore();
  }

  putDoc(_id: string, raw: unknown): string {
    const store = DocStore.fromJSON(this.registry, raw);
    this.setStore(store);
    save(store, this.filePath);
    return 'default';
  }
}

/** 旧签名（{store, filePath}）到 DocContext 的适配 */
export function singleDocContext(
  registry: NodeTypeRegistry,
  filePath: string,
  getStore: () => DocStore,
  setStore: (s: DocStore) => void = () => {},
): DocContext {
  return new SingleDocContext(registry, filePath, getStore, setStore);
}
