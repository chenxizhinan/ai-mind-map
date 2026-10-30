import type { Annotation, MindDocument, MindNode } from './types.js';
import { DOC_VERSION } from './types.js';
import type { NodeTypeRegistry } from './node-type.js';

export class DocValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'DocValidationError';
  }
}

/**
 * 文档内存存储：树 + 批注的唯一运行时副本。
 *
 * - id 全文档统一分配（n_0001 递增），树操作不改已有 id。
 * - 所有写入都经过 NodeTypeRegistry 校验。
 * - 每次 mutation 后 updatedAt 更新，供文件监听对比。
 */
export class DocStore {
  private doc: MindDocument;
  private nextId = 1;
  private index = new Map<string, MindNode>();
  private listeners = new Set<(doc: MindDocument) => void>();

  constructor(
    private registry: NodeTypeRegistry,
    initial?: Partial<MindDocument>,
  ) {
    this.doc = {
      version: DOC_VERSION,
      meta: {
        title: initial?.meta?.title ?? '未命名导图',
        updatedAt: initial?.meta?.updatedAt ?? nowIso(),
      },
      tree: (initial?.tree as MindNode | undefined) ?? this.emptyTree(),
      annotations: initial?.annotations ?? [],
    };
    if (this.doc.tree.children === undefined) this.doc.tree.children = [];
    this.reindex();
    this.ensureUniqueIds();
  }

  get document(): MindDocument {
    return this.doc;
  }

  get root(): MindNode {
    return this.doc.tree;
  }

  onChange(listener: (doc: MindDocument) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.doc.meta.updatedAt = nowIso();
    for (const l of this.listeners) l(this.doc);
  }

  private emptyTree(): MindNode {
    return {
      id: this.allocId(),
      type: 'folder',
      text: '根节点',
      props: {},
      children: [],
    };
  }

  private allocId(): string {
    return `n_${String(this.nextId++).padStart(4, '0')}`;
  }

  private reindex(): void {
    this.index.clear();
    let max = 0;
    const walk = (n: MindNode): void => {
      this.index.set(n.id, n);
      const m = /^n_(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, Number(m[1]));
      for (const c of n.children ?? []) walk(c);
    };
    walk(this.doc.tree);
    this.nextId = max + 1;
  }

  /**
   * 自愈：保证每个节点都有非空且文档内唯一的 id。
   * 导入/AI 生成的文档可能缺 id 或 id 重复（会导致无法选中、编辑串节点），
   * 这里统一补成 n_XXXX（沿用 allocId 的递增规则），已有合法 id 保持不变。
   */
  private ensureUniqueIds(): void {
    const seen = new Set<string>();
    let changed = false;
    const walk = (n: MindNode): void => {
      if (!n.id || seen.has(n.id)) {
        n.id = this.allocId();
        changed = true;
      }
      seen.add(n.id);
      for (const c of n.children ?? []) walk(c);
    };
    walk(this.doc.tree);
    if (changed) this.reindex();
  }

  getNode(id: string): MindNode | undefined {
    return this.index.get(id);
  }

  getParent(id: string): MindNode | undefined {
    const walk = (n: MindNode): MindNode | undefined => {
      for (const c of n.children ?? []) {
        if (c.id === id) return n;
        const found = walk(c);
        if (found) return found;
      }
      return undefined;
    };
    return walk(this.doc.tree);
  }

  /** 校验并插入子树；id 由本方法统一分配（子树中已有 id 的节点保留原 id） */
  addSubtree(parentId: string, subtreeInput: unknown): { nodeId: string; assignedIds: string[] } {
    const parent = this.requireNode(parentId);
    const parentType = this.registry.get(parent.type);
    if (parentType.leafOnly) {
      throw new Error(`parent ${parentId} is leafOnly (${parent.type}), cannot add children`);
    }
    const subtree = this.registry.normalizeNode(subtreeInput);
    const assignedIds: string[] = [];
    const walk = (n: MindNode): void => {
      if (!n.id) {
        n.id = this.allocId();
        assignedIds.push(n.id);
      } else if (this.index.has(n.id)) {
        throw new Error(`duplicate node id ${n.id}`);
      }
      this.index.set(n.id, n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(subtree);
    parent.children = parent.children ?? [];
    parent.children.push(subtree);
    this.emit();
    return { nodeId: subtree.id, assignedIds };
  }

  updateNode(id: string, fields: { text?: string; props?: unknown }): MindNode {
    const node = this.requireNode(id);
    const type = this.registry.get(node.type);
    if (fields.text !== undefined) {
      if (typeof fields.text !== 'string') throw new Error('text must be a string');
      node.text = fields.text;
    }
    if (fields.props !== undefined) {
      node.props = type.normalizeProps({ ...node.props, ...(fields.props as Record<string, unknown>) });
    }
    this.emit();
    return node;
  }

  /** 改节点类型（扩展性的关键：叶子语义变化时不重建节点） */
  setNodeType(id: string, newType: string): MindNode {
    const node = this.requireNode(id);
    const type = this.registry.get(newType);
    if (type.leafOnly && (node.children?.length ?? 0) > 0) {
      throw new Error(`cannot convert to leafOnly type "${newType}" while node has children`);
    }
    node.props = type.normalizeProps(node.props);
    node.type = newType;
    this.emit();
    return node;
  }

  deleteSubtree(id: string): { removedIds: string[] } {
    if (id === this.doc.tree.id) throw new Error('cannot delete root');
    const parent = this.requireParent(id);
    const removedIds: string[] = [];
    const collect = (n: MindNode): void => {
      removedIds.push(n.id);
      this.index.delete(n.id);
      for (const c of n.children ?? []) collect(c);
    };
    collect(this.requireNode(id));
    parent.children = (parent.children ?? []).filter((c) => c.id !== id);
    this.emit();
    return { removedIds };
  }

  moveSubtree(id: string, newParentId: string, index?: number): void {
    if (id === this.doc.tree.id) throw new Error('cannot move root');
    const node = this.requireNode(id);
    const newParent = this.requireNode(newParentId);
    if (newParentTypeIsLeaf(newParent, this.registry)) {
      throw new Error(`new parent ${newParentId} is leafOnly`);
    }
    // 防止把自己的祖先挂到自己下面
    let a: MindNode | undefined = newParent;
    while (a) {
      if (a.id === id) throw new Error('cannot move a subtree under itself');
      a = this.getParent(a.id);
    }
    const oldParent = this.requireParent(id);
    oldParent.children = (oldParent.children ?? []).filter((c) => c.id !== id);
    (newParent.children = newParent.children ?? []).splice(index ?? newParent.children.length, 0, node);
    this.emit();
  }

  // ---------- 批注 ----------

  addAnnotation(nodeId: string, body: string, createdBy: string): Annotation {
    this.requireNode(nodeId);
    const ann: Annotation = {
      id: `a_${String(this.doc.annotations.length + 1).padStart(4, '0')}`,
      nodeId,
      createdBy,
      createdAt: nowIso(),
      body,
      status: 'open',
      replies: [],
    };
    this.doc.annotations.push(ann);
    this.emit();
    return ann;
  }

  replyAnnotation(annotationId: string, body: string, createdBy: string): Annotation {
    const ann = this.requireAnnotation(annotationId);
    ann.replies.push({ id: `${ann.id}_r${ann.replies.length + 1}`, createdBy, createdAt: nowIso(), body });
    this.emit();
    return ann;
  }

  setAnnotationStatus(annotationId: string, status: 'open' | 'resolved'): Annotation {
    const ann = this.requireAnnotation(annotationId);
    ann.status = status;
    this.emit();
    return ann;
  }

  listAnnotations(nodeId?: string, status?: 'open' | 'resolved'): Annotation[] {
    return this.doc.annotations.filter(
      (a) => (nodeId ? a.nodeId === nodeId : true) && (status ? a.status === status : true),
    );
  }

  /** 节点未解决批注数（renderer 画角标用） */
  openAnnotationCount(nodeId: string): number {
    return this.doc.annotations.filter((a) => a.nodeId === nodeId && a.status === 'open').length;
  }

  // ---------- 序列化 ----------

  toJSON(): MindDocument {
    return this.doc;
  }

  static fromJSON(registry: NodeTypeRegistry, raw: unknown): DocStore {
    if (typeof raw !== 'object' || raw === null) throw new Error('document must be an object');
    const d = raw as Partial<MindDocument>;
    if (d.version !== DOC_VERSION) throw new Error(`unsupported document version ${d.version}`);
    if (typeof d.tree !== 'object' || d.tree === null) throw new Error('missing tree');
    const tree = registry.normalizeNode(d.tree);
    return new DocStore(registry, { tree, annotations: d.annotations ?? [], meta: d.meta });
  }

  private requireNode(id: string): MindNode {
    const n = this.index.get(id);
    if (!n) throw new Error(`node not found: ${id}`);
    return n;
  }

  private requireParent(id: string): MindNode {
    const p = this.getParent(id);
    if (!p) throw new Error(`parent not found for: ${id}`);
    return p;
  }

  private requireAnnotation(id: string): Annotation {
    const a = this.doc.annotations.find((x) => x.id === id);
    if (!a) throw new Error(`annotation not found: ${id}`);
    return a;
  }
}

function newParentTypeIsLeaf(parent: MindNode, registry: NodeTypeRegistry): boolean {
  return registry.get(parent.type).leafOnly === true;
}

function nowIso(): string {
  return new Date().toISOString();
}
