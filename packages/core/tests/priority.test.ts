import { describe, expect, it } from 'vitest';
import {
  PRIORITY_LEVELS,
  PRIORITY_SPECS,
  PRIORITY_RULES,
  priorityRubricText,
  renderMethodPrompt,
} from '../src/index.js';

describe('用例优先级规范（P0-P3）', () => {
  it('四个等级都有定义、示例与执行要求', () => {
    expect([...PRIORITY_LEVELS]).toEqual(['P0', 'P1', 'P2', 'P3']);
    for (const level of PRIORITY_LEVELS) {
      const spec = PRIORITY_SPECS[level];
      expect(spec.definition.length).toBeGreaterThan(6);
      expect(spec.examples.length).toBeGreaterThan(6);
      expect(spec.execution.length).toBeGreaterThan(6);
    }
    expect(PRIORITY_SPECS.P0.definition).toContain('阻塞发布');
  });

  it('定级规则覆盖关键判断点', () => {
    const rules = PRIORITY_RULES.join('\n');
    expect(rules).toContain('业务影响');
    expect(rules).toContain('不是开发工作量');
    expect(rules).toContain('越权');
    expect(rules).toContain('不允许默认全部生成 P0');
    expect(rules).toContain('独立阻断理由');
    expect(rules).toContain('低风险专项可以没有 P0');
    expect(rules).toContain('失败是否禁止发布');
  });

  it('prompt 文本包含 P0-P3 定义与定级规则', () => {
    const text = priorityRubricText();
    expect(text).toContain('优先级定级规范');
    expect(text).toContain('P0：失败会阻塞发布');
    expect(text).toContain('P1：高业务风险');
    expect(text).toContain('P2：次要功能');
    expect(text).toContain('P3：极低概率');
    expect(text).toContain('失败是否禁止发布');
  });

  it('get_test_methods 的约束段落始终包含优先级定级规范', () => {
    const generic = renderMethodPrompt([]);
    expect(generic).toContain('优先级定级规范');
    expect(generic).toContain('P0：失败会阻塞发布');
    const withDims = renderMethodPrompt(['functional']);
    expect(withDims).toContain('优先级定级规范');
    expect(withDims).toContain('P3：极低概率');
  });
});
