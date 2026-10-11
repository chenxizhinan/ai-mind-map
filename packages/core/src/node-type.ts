import type { BaseNode } from './types.js';

/**
 * 节点类型扩展点。
 *
 * 一个 NodeType 描述某一类节点的行为与校验规则。core 只依赖本接口，
 * 不依赖任何具体类型——「用例」「模块路径」等都是外部注册进来的。
 */
export interface NodeType<TProps extends Record<string, unknown> = Record<string, unknown>> {
  /** 类型标识，写进 node.type */
  name: string;
  /** 展示名（UI 用） */
  label: string;
  /** 该类型能否作为叶子（无子节点）。如 case 应为 true；path 应为 false。 */
  readonly leafOnly?: boolean;
  /** 树视图中该类型节点允许的最大子节点数；Infinity 表示不限 */
  readonly maxChildren?: number;

  /**
   * 校验/规范化业务字段。写入路径（MCP 工具、表单保存）都必须经过它。
   * 返回规范化后的 props；抛出 Error 表示拒绝写入。
   */
  normalizeProps(input: unknown): TProps;

  /**
   * 渲染摘要：画布节点文本之外的一行小字（如用例的「P1 · 3步」），
   * 以及优先级/状态等徽标信息。返回 null 表示无摘要。
   */
  describe?(props: TProps): Badge[];

  /**
   * 节点在树视图中的角色提示，用于布局与交互的默认行为。
   * container：容器/路径节点，通常默认展开；leaf：叶子内容节点，通常默认折叠。
   */
  readonly role?: 'container' | 'leaf';
}

/** 画布徽标（优先级色条、批注数以外的类型私有标记） */
export interface Badge {
  text: string;
  tone?: 'critical' | 'warning' | 'info' | 'muted';
}

/** 运行时类型注册表。core/mcp/renderer 共享同一个注册表实例。 */
export class NodeTypeRegistry {
  private types = new Map<string, NodeType>();

  register(type: NodeType): void {
    if (this.types.has(type.name)) {
      throw new Error(`NodeType "${type.name}" already registered`);
    }
    this.types.set(type.name, type);
  }

  get(name: string): NodeType {
    const t = this.types.get(name);
    if (!t) {
      throw new Error(`Unknown node type "${name}". Registered: ${[...this.types.keys()].join(', ')}`);
    }
    return t;
  }

  has(name: string): boolean {
    return this.types.has(name);
  }

  list(): NodeType[] {
    return [...this.types.values()];
  }

  /** 校验并规范化一个节点（递归校验子树由调用方负责） */
  normalizeNode(input: unknown): BaseNode {
    const n = input as Partial<BaseNode>;
    if (typeof n !== 'object' || n === null) throw new Error('node must be an object');
    if (typeof n.type !== 'string') throw new Error('node.type must be a string');
    const type = this.get(n.type);
    if (typeof n.text !== 'string') throw new Error('node.text must be a string');
    if (n.children !== undefined && !Array.isArray(n.children)) {
      throw new Error('node.children must be an array');
    }
    if (type.leafOnly && Array.isArray(n.children) && n.children.length > 0) {
      throw new Error(`NodeType "${type.name}" is leafOnly but has ${n.children.length} children`);
    }
    const max = type.maxChildren ?? Infinity;
    if (Array.isArray(n.children) && n.children.length > max) {
      throw new Error(`NodeType "${type.name}" allows at most ${max} children`);
    }
    return {
      id: n.id ?? '',
      type: n.type,
      text: n.text,
      props: type.normalizeProps(n.props ?? {}),
      children: (n.children ?? []).map((c) => this.normalizeNode(c)),
    } as BaseNode;
  }
}
