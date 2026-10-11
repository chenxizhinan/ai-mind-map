/**
 * 随包附带的示例节点类型：folder（路径/容器）与 case（测试用例）。
 *
 * 它们不是 core 的硬编码——只通过 registerBuiltinTypes() 注册；
 * 业务方完全可以不注册它们，只用自己的类型。
 */
import type { Badge, NodeType, NodeTypeRegistry } from './node-type.js';

export interface FolderProps extends Record<string, unknown> {
  note?: string;
}

export interface CaseProps extends Record<string, unknown> {
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  precondition?: string;
  steps?: string[];
  expected?: string;
  tags?: string[];
}

const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

export const folderType: NodeType<FolderProps> = {
  name: 'folder',
  label: '模块/路径',
  role: 'container',
  normalizeProps(input) {
    const p = (input ?? {}) as Partial<FolderProps>;
    return {
      note: typeof p.note === 'string' ? p.note : undefined,
    };
  },
};

export const caseType: NodeType<CaseProps> = {
  name: 'case',
  label: '测试用例',
  role: 'leaf',
  leafOnly: true,
  normalizeProps(input) {
    const p = (input ?? {}) as Partial<CaseProps>;
    if (p.priority !== undefined && !PRIORITIES.has(p.priority)) {
      throw new Error(`priority must be one of P0-P3, got "${p.priority}"`);
    }
    if (p.steps !== undefined && !Array.isArray(p.steps)) {
      throw new Error('steps must be an array of strings');
    }
    return {
      priority: p.priority,
      precondition: typeof p.precondition === 'string' ? p.precondition : undefined,
      steps: Array.isArray(p.steps) ? p.steps.map(String) : undefined,
      expected: typeof p.expected === 'string' ? p.expected : undefined,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
    };
  },
  describe(props) {
    const p = (props ?? {}) as Partial<CaseProps>;
    const badges: Badge[] = [];
    if (p.priority) badges.push({ text: p.priority, tone: priorityTone(p.priority) });
    if (p.steps?.length) badges.push({ text: `${p.steps.length}步`, tone: 'muted' });
    return badges;
  },
};

function priorityTone(p: string): Badge['tone'] {
  switch (p) {
    case 'P0':
      return 'critical';
    case 'P1':
      return 'warning';
    case 'P2':
      return 'info';
    default:
      return 'muted';
  }
}

export function registerBuiltinTypes(registry: NodeTypeRegistry): void {
  registry.register(folderType);
  registry.register(caseType);
}
