/**
 * 核心数据类型：文档、树、扁平节点。
 *
 * 设计原则（对应 docs/design/architecture-draft.md §3）：
 * - 树数据（tree）与批注（annotations）分节存放，批注以 nodeId 关联。
 * - 节点的业务字段由「节点类型注册表」决定，core 不硬编码任何业务语义
 *   （用例/路径只是随包附带的示例类型）。
 */

/** 文档格式版本 */
export const DOC_VERSION = 1;

/** 扁平节点的公共字段。业务扩展字段放在 `props` 里，由节点类型定义。 */
export interface BaseNode {
  /** 全文档唯一 id，由 DocStore 分配（n_0001 递增） */
  id: string;
  /** 节点类型，必须在 NodeTypeRegistry 中注册过 */
  type: string;
  /** 节点主文本（树视图中直接展示的一行） */
  text: string;
  /** 类型私有业务字段（如用例的 steps/expected），结构由 NodeType 声明 */
  props: Record<string, unknown>;
  children: MindNode[];
}

export type MindNode = BaseNode;

/** 评审批注线程 */
export interface Annotation {
  id: string;
  nodeId: string;
  createdBy: 'user' | 'ai' | (string & {});
  createdAt: string;
  body: string;
  status: 'open' | 'resolved';
  replies: AnnotationReply[];
}

export interface AnnotationReply {
  id: string;
  createdBy: 'user' | 'ai' | (string & {});
  createdAt: string;
  body: string;
}

export interface DocumentMeta {
  title: string;
  updatedAt: string;
}

/** 单一数据源文件的内容（如 testcases.mindmap.json） */
export interface MindDocument {
  version: typeof DOC_VERSION;
  meta: DocumentMeta;
  tree: MindNode;
  annotations: Annotation[];
}

/** 布局后的扁平节点（renderer 输入）。树操作与渲染解耦的关键。 */
export interface FlatNode {
  id: string;
  type: string;
  text: string;
  props: Record<string, unknown>;
  depth: number;
  parentId: string | null;
  /** 布局坐标（世界坐标，px） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 子节点是否被折叠隐藏（含被折叠祖先隐藏的情况） */
  hidden: boolean;
  /** 直接子节点数 */
  childCount: number;
}

/** 树的持久化快照（可选导出用） */
export interface TreeSnapshot {
  nodes: MindNode[];
  assignedIds: string[];
}
