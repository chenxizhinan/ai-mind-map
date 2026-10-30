/**
 * 用例优先级规范（P0–P3）。
 *
 * 优先级描述的是“该用例失败对发布与业务的风险”，不是开发工作量，
 * 也不是缺陷严重程度本身。所有 AI 生成 / 评审 / 导出都应引用同一套定义。
 */

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export const PRIORITY_LEVELS = ['P0', 'P1', 'P2', 'P3'] as const;

export interface PrioritySpec {
  level: Priority;
  /** 一句话定义 */
  definition: string;
  /** 典型用例 */
  examples: string;
  /** 执行/发布要求 */
  execution: string;
}

export const PRIORITY_SPECS: Record<Priority, PrioritySpec> = {
  P0: {
    level: 'P0',
    definition: '失败会阻塞发布，且没有可接受的临时绕行、降级或风险接受方案。',
    examples: '核心链路完全不可用、不可恢复的数据损坏、严重越权、敏感信息泄露或关键隔离失效。',
    execution: '每次发布必须执行，失败即停止发布。',
  },
  P1: {
    level: 'P1',
    definition: '高业务风险或高发生概率，通常需要修复；若发布，必须明确接受风险并给出缓解或绕行方案。',
    examples: '主要功能受损、可恢复的数据不一致、关键兼容链路、主要异常恢复或关键审计缺失。',
    execution: '完整回归必须执行；失败需修复或显式风险接受。',
  },
  P2: {
    level: 'P2',
    definition: '次要功能、低概率边界或影响范围有限的问题。',
    examples: '表单校验、状态刷新、非关键筛选、提示信息、低频兼容组合、补充 Provider。',
    execution: '常规回归执行，按风险决定是否阻塞。',
  },
  P3: {
    level: 'P3',
    definition: '极低概率、低影响、探索性或页面无法直接触发的防御性场景。',
    examples: '重复调用隐藏接口、轻微展示问题、非关键审计补充、极端输入组合、长期稳定性探索。',
    execution: '定向或周期性执行，通常不阻塞发布。',
  },
};

/** 定级判断与约束规则（硬性） */
export const PRIORITY_RULES: readonly string[] = [
  '优先级依据是“业务影响 × 发生概率 × 恢复难度 × 数据/安全风险 × 是否版本核心目标”，不是开发工作量。',
  '正常、异常、安全、接口用例都不能机械地固定成某个优先级。',
  '安全或数据用例只有涉及越权、敏感信息、数据损坏、跨企业隔离时才提升为 P0。',
  '页面没有操作入口、只能通过接口模拟的防御性场景，通常是 P2/P3。',
  '不允许默认全部生成 P0；同一分组全部为 P0 时，每条都必须有独立阻断理由。',
  '无法确认时标记待确认并记录缺失事实，不通过机械上调优先级掩盖信息不足。',
  '优先级比例只用于发现异常分布，不能反向决定单条用例的优先级；低风险专项可以没有 P0。',
  '用例发生范围或风险变化时，允许重新定级，并同步更新备注。',
  'P0/P1 必须具备可执行步骤和明确断言，不能只写概念性检查。',
  'P0 必须能回答“该用例失败是否禁止发布”；P0/P1 备注应说明失败影响或定级依据。',
];

/** 渲染为 prompt / 文档用的多行文本 */
export function priorityRubricText(): string {
  const table = PRIORITY_LEVELS.map((level) => {
    const s = PRIORITY_SPECS[level];
    return `- ${level}：${s.definition} 典型：${s.examples} 执行：${s.execution}`;
  });
  return [
    '优先级定级规范（P0-P3，硬性）：',
    ...table,
    '定级规则：',
    ...PRIORITY_RULES.map((r) => `- ${r}`),
  ].join('\n');
}

/** 供代码内 UI 展示的短标签 */
export const PRIORITY_SHORT_LABELS: Record<Priority, string> = {
  P0: 'P0 · 阻塞发布',
  P1: 'P1 · 重要功能',
  P2: 'P2 · 次要/低频',
  P3: 'P3 · 防御/探索',
};
