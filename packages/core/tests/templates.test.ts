import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  buildTemplateDoc,
  findTemplate,
  renderMethodPrompt,
  DocStore,
  NodeTypeRegistry,
  registerBuiltinTypes,
} from '../src/index.js';

function makeRegistry(): NodeTypeRegistry {
  const r = new NodeTypeRegistry();
  registerBuiltinTypes(r);
  return r;
}

describe('templates', () => {
  it('内置模板包含空白与测试用例模板', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toContain('blank');
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toContain('testcase');
    expect(findTemplate('testcase')?.tags).toContain('测试');
  });

  it('测试用例模板含 6 大测试维度且 method 标注可存活', () => {
    const r = makeRegistry();
    const d = buildTemplateDoc('testcase', '支付中台');
    const s = DocStore.fromJSON(r, d);
    expect(s.root.text).toBe('支付中台'); // 根名=文档名
    const dims = s.root.children.map((c) => String((c.props as { method?: string }).method));
    expect(dims).toEqual(['functional', 'boundary', 'exception', 'security', 'performance', 'compatibility']);
  });

  it('renderMethodPrompt 按维度生成约束；未知维度回退通用段', () => {
    const withDims = renderMethodPrompt(['functional', 'boundary']);
    expect(withDims).toContain('【功能测试】');
    expect(withDims).toContain('边界值分析');
    expect(renderMethodPrompt([])).toContain('等价类划分');
    expect(renderMethodPrompt(['nope'])).toContain('等价类划分');
  });

  it('buildTemplateDoc 未知模板 id 回退空白', () => {
    const d = buildTemplateDoc('nope', 'x');
    expect(d.tree.children).toHaveLength(0);
  });
});
