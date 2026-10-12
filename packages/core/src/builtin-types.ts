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
  /** 用例类型：functional/performance/security/api/compatibility/…（对齐 method 方向） */
  caseType?: string;
  precondition?: string;
  steps?: string[];
  expected?: string;
  /** 备注 */
  remark?: string;
}

export const CASE_TYPES = [
  { key: 'functional', label: '功能' },
  { key: 'boundary', label: '边界' },
  { key: 'exception', label: '异常' },
  { key: 'security', label: '安全' },
  { key: 'performance', label: '性能' },
  { key: 'compatibility', label: '兼容' },
  { key: 'api', label: '接口' },
  { key: 'data', label: '数据' },
  { key: 'ui', label: '交互' },
  { key: 'workflow', label: '流程' },
] as const;

const CASE_TYPE_KEYS: Set<string> = new Set(CASE_TYPES.map((t) => t.key));

const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

/**
 * 通用样式字段：不属于业务语义，由 UI（样式面板）直接写入、渲染层读取。
 * normalizeProps 只负责业务字段校验，样式字段在此统一透传，
 * 避免每个自定义类型都要记得处理它们。
 */
function passVisualStyle<T extends Record<string, unknown>>(p: Record<string, unknown>, out: T): T {
  const outRec = out as Record<string, unknown>;
  if (typeof p.color === 'string' && p.color) outRec.color = p.color;
  else delete outRec.color;
  if (typeof p.icon === 'string' && p.icon) outRec.icon = p.icon;
  else delete outRec.icon;
  // 测试维度标注（模板一级节点）：AI 生成用例时读取此约束
  if (typeof p.method === 'string' && p.method) outRec.method = p.method;
  else delete outRec.method;
  return out;
}

export const folderType: NodeType<FolderProps> = {
  name: 'folder',
  label: '模块/路径',
  role: 'container',
  normalizeProps(input) {
    const p = (input ?? {}) as Partial<FolderProps> & Record<string, unknown>;
    return passVisualStyle(p, {
      note: typeof p.note === 'string' ? p.note : undefined,
    });
  },
};

export const caseType: NodeType<CaseProps> = {
  name: 'case',
  label: '测试用例',
  role: 'leaf',
  leafOnly: true,
  normalizeProps(input) {
    const p = (input ?? {}) as Partial<CaseProps> & Record<string, unknown>;
    if (p.priority !== undefined && !PRIORITIES.has(p.priority)) {
      throw new Error(`priority must be one of P0-P3, got "${p.priority}"`);
    }
    if (p.steps !== undefined && !Array.isArray(p.steps)) {
      throw new Error('steps must be an array of strings');
    }
    return passVisualStyle(p, {
      priority: p.priority,
      caseType: typeof p.caseType === 'string' && CASE_TYPE_KEYS.has(p.caseType) ? p.caseType : undefined,
      precondition: typeof p.precondition === 'string' ? p.precondition : undefined,
      steps: Array.isArray(p.steps) ? p.steps.map(String) : undefined,
      expected: typeof p.expected === 'string' ? p.expected : undefined,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
      remark: typeof p.remark === 'string' ? p.remark : undefined,
    });
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
