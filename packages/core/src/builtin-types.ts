/**
 * 随包附带的示例节点类型：folder（路径/容器）与 case（测试用例）。
 *
 * 它们不是 core 的硬编码——只通过 registerBuiltinTypes() 注册；
 * 业务方完全可以不注册它们，只用自己的类型。
 */
import type { Badge, NodeType, NodeTypeRegistry } from './node-type.js';
import { PRIORITY_LEVELS, type Priority } from './priority.js';

export interface FolderProps extends Record<string, unknown> {
  note?: string;
  /** 详情：可放长文本（背景、数据清单、链接等），节点标题保持简短 */
  detail?: string;
}

/**
 * 用例执行状态：通过/阻塞/失败。
 * 未执行 = 不写 exec（默认），UI 与导出均不展示。
 */
export const EXEC_STATUSES = ['pass', 'blocked', 'fail'] as const;
export type ExecStatus = (typeof EXEC_STATUSES)[number];
const EXEC_STATUS_SET: Set<string> = new Set(EXEC_STATUSES);

export interface CaseProps extends Record<string, unknown> {
  priority?: Priority;
  /** 用例类型：验证哪类质量风险 */
  caseType?: string;
  /** 测试层级：从哪一层验证 */
  testLevel?: string;
  precondition?: string;
  steps?: string[];
  expected?: string;
  /** 备注 */
  remark?: string;
  /** 执行状态（缺省 = 未执行，不展示） */
  exec?: ExecStatus;
}

export const CASE_TYPES = [
  { key: 'functional', label: '功能' },
  { key: 'boundary', label: '边界' },
  { key: 'exception', label: '异常' },
  { key: 'security', label: '安全' },
  { key: 'performance', label: '性能' },
  { key: 'compatibility', label: '兼容' },
  { key: 'data', label: '数据' },
  { key: 'workflow', label: '流程' },
  { key: 'reliability', label: '可靠性' },
  { key: 'accessibility', label: '可访问性' },
  { key: 'localization', label: '国际化' },
] as const;

const CASE_TYPE_KEYS: Set<string> = new Set(CASE_TYPES.map((t) => t.key));

export const TEST_LEVELS = [
  { key: 'ui', label: 'UI' },
  { key: 'api', label: 'API' },
  { key: 'service', label: '服务' },
  { key: 'database', label: '数据库' },
  { key: 'contract', label: '契约' },
  { key: 'e2e', label: '端到端' },
] as const;

const TEST_LEVEL_KEYS: Set<string> = new Set(TEST_LEVELS.map((level) => level.key));
const LEGACY_LEVEL_CASE_TYPES = new Set(['api', 'ui']);

const PRIORITIES = new Set<string>(PRIORITY_LEVELS);

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
  // 执行标记（case）：pass/fail/blocked
  if (typeof p.exec === 'string' && p.exec) outRec.exec = p.exec;
  else delete outRec.exec;
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
      detail: typeof p.detail === 'string' ? p.detail : undefined,
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
    const legacyLevel = typeof p.caseType === 'string' && LEGACY_LEVEL_CASE_TYPES.has(p.caseType) ? p.caseType : undefined;
    const out = passVisualStyle(p, {
      priority: p.priority,
      // 旧数据曾把 api/ui 放在 caseType；读取时无损迁移为“功能 + 对应测试层级”。
      caseType: legacyLevel ? 'functional' : typeof p.caseType === 'string' && CASE_TYPE_KEYS.has(p.caseType) ? p.caseType : undefined,
      testLevel:
        typeof p.testLevel === 'string' && TEST_LEVEL_KEYS.has(p.testLevel)
          ? p.testLevel
          : legacyLevel,
      precondition: typeof p.precondition === 'string' ? p.precondition : undefined,
      steps: Array.isArray(p.steps) ? p.steps.map(String) : undefined,
      expected: typeof p.expected === 'string' ? p.expected : undefined,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
      remark: typeof p.remark === 'string' ? p.remark : undefined,
    });
    // 执行状态只接受 pass/blocked/fail；未执行（缺省）与未知值一律丢弃，不渲染
    const outRec = out as Record<string, unknown>;
    if (typeof outRec.exec === 'string' && !EXEC_STATUS_SET.has(outRec.exec)) {
      delete outRec.exec;
    }
    return out;
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
