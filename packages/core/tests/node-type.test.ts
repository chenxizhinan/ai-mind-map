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
