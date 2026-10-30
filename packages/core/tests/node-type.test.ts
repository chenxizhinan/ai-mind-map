import { describe, expect, it } from 'vitest';
import { NodeTypeRegistry, registerBuiltinTypes } from '../src/index.js';
import type { NodeTypeRegistry as Registry } from '../src/index.js';

function makeRegistry(): Registry {
  const registry = new NodeTypeRegistry();
  registerBuiltinTypes(registry);
  return registry;
}

describe('NodeTypeRegistry', () => {
  it('rejects duplicate registration', () => {
    const registry = makeRegistry();
    expect(() => registerBuiltinTypes(registry)).toThrow(/already registered/);
  });

  it('rejects unknown type', () => {
    const registry = makeRegistry();
    expect(() => registry.get('nope')).toThrow(/Unknown node type/);
  });

  it('normalizeProps rejects invalid priority', () => {
    const registry = makeRegistry();
    expect(() =>
      registry.normalizeNode({ type: 'case', text: 't', props: { priority: 'PX' } }),
    ).toThrow(/priority/);
  });

  it('leafOnly type cannot have children', () => {
    const registry = makeRegistry();
    expect(() =>
      registry.normalizeNode({
        type: 'case',
        text: 't',
        children: [{ type: 'folder', text: 'x' }],
      }),
    ).toThrow(/leafOnly/);
  });

  it('case exec accepts pass/blocked/fail, drops 未执行与未知值', () => {
    const registry = makeRegistry();
    const propsOf = (exec: unknown) =>
      registry.normalizeNode({ type: 'case', text: 't', props: { exec } }).props;
    expect(propsOf('pass')).toEqual({ exec: 'pass' });
    expect(propsOf('blocked')).toEqual({ exec: 'blocked' });
    expect(propsOf('fail')).toEqual({ exec: 'fail' });
    expect(propsOf('unexecuted')).toEqual({});
    expect(propsOf('none')).toEqual({});
    expect(propsOf('')).toEqual({});
    expect(propsOf(undefined)).toEqual({});
  });

  it('case separates test type and test level, and migrates legacy api/ui caseType', () => {
    const registry = makeRegistry();
    expect(
      registry.normalizeNode({
        type: 'case',
        text: 't',
        props: { caseType: 'security', testLevel: 'api' },
      }).props,
    ).toEqual({ caseType: 'security', testLevel: 'api' });
    expect(
      registry.normalizeNode({ type: 'case', text: 'legacy', props: { caseType: 'ui' } }).props,
    ).toEqual({ caseType: 'functional', testLevel: 'ui' });
  });

  it('folder keeps long 详情 text', () => {
    const registry = makeRegistry();
    const long = '前置数据：'.repeat(80);
    const props = registry.normalizeNode({
      type: 'folder',
      text: '准备测试数据',
      props: { note: '基线', detail: long },
    }).props;
    expect(props).toEqual({ note: '基线', detail: long });
    // 非字符串的 detail 被丢弃
    expect(
      registry.normalizeNode({ type: 'folder', text: 'x', props: { detail: 123 } }).props.detail,
    ).toBeUndefined();
  });

  it('custom node types are first-class', () => {
    const registry = makeRegistry();
    registry.register({
      name: 'risk',
      label: '风险项',
      leafOnly: true,
      normalizeProps: (i) => ({ level: (i as { level?: string }).level ?? 'low' }),
    });
    const n = registry.normalizeNode({ type: 'risk', text: '支付网关单点', props: { level: 'high' } });
    expect(n.props).toEqual({ level: 'high' });
    expect(() =>
      registry.normalizeNode({ type: 'risk', text: 'x', children: [{ type: 'risk', text: 'y' }] }),
    ).toThrow(/leafOnly/);
  });
});
