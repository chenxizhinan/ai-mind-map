import { describe, expect, it } from 'vitest';
import {
  NodeTypeRegistry,
  registerBuiltinTypes,
  encodeXmind,
  decodeXmind,
  buildXmindRootTopic,
  encodeMarkdown,
  decodeMarkdown,
} from '../src/index.js';
import type { MindNode } from '../src/index.js';

function makeRegistry() {
  const r = new NodeTypeRegistry();
  registerBuiltinTypes(r);
  return r;
}

function sampleTree(): MindNode {
  return {
    id: 'n_0001',
    type: 'folder',
    text: '订单中心',
    props: {},
    children: [
      {
        id: 'n_0002',
        type: 'folder',
        text: '登录模块',
        props: {},
        children: [
          {
            id: 'n_0003',
            type: 'case',
            text: '正确密码登录成功',
            props: {
              priority: 'P1',
              precondition: '已注册用户',
              steps: ['打开登录页', '输入正确账号密码', '点击登录'],
              expected: '跳转首页',
            },
            children: [],
          },
          {
            id: 'n_0004',
            type: 'case',
            text: '错误密码提示',
            props: { priority: 'P2', expected: '提示密码错误' },
            children: [],
          },
          {
            id: 'n_0005',
            type: 'folder',
            text: '嵌套路径',
            props: {},
            children: [{ id: 'n_0006', type: 'case', text: '深用例', props: {}, children: [] }],
          },
        ],
      },
    ],
  };
}

describe('XMind roundtrip', () => {
  it('encode → decode 恢复树结构与字段', () => {
    const bytes = encodeXmind(sampleTree(), '订单用例');
    const { tree: restored, warnings } = decodeXmind(bytes, makeRegistry());
    expect(warnings).toEqual([]);
    expect(restored.text).toBe('订单中心');
    expect(restored.children![0]!.text).toBe('登录模块');

    const c1 = restored.children![0]!.children![0]!;
    expect(c1.text).toBe('正确密码登录成功');
    expect(c1.props.priority).toBe('P1');
    expect(c1.props.precondition).toBe('已注册用户');
    expect(c1.props.steps).toEqual(['打开登录页', '输入正确账号密码', '点击登录']);
    expect(c1.props.expected).toBe('跳转首页');

    // 深层路径
    const deep = restored.children![0]!.children![2]!.children![0]!;
    expect(deep.text).toBe('深用例');
  });

  it('导出的 case 字段子主题符合 MeterSphere 中文键约定', () => {
    const zen = buildXmindRootTopic(sampleTree());
    const login = zen.children?.attached?.[0];
    const c1 = login?.children?.attached?.[0];
    expect(c1).toBeTruthy();
    const titles = (c1?.children?.attached ?? []).map((t) => t.title);
    expect(titles).toContain('前置条件：已注册用户');
    // 步骤在「步骤描述：」分组下，预期结果嵌在首个步骤下
    const stepsGroup = (c1?.children?.attached ?? []).find((t) => t.title === '步骤描述：');
    expect(stepsGroup).toBeTruthy();
    const stepTitles = (stepsGroup?.children?.attached ?? []).map((t) => t.title);
    expect(stepTitles.some((t) => /^步骤\d+：/.test(t!))).toBe(true);
    const firstStep = stepsGroup!.children!.attached![0]!;
    expect((firstStep.children?.attached ?? []).some((t) => t.title!.startsWith('预期结果：'))).toBe(true);
    expect(c1!.markers).toEqual([{ markerId: 'priority-2' }]);
  });
});

describe('Markdown encode', () => {
  it('根 = #，子级 = ##/###，字段为列表项', () => {
    const md = encodeMarkdown(sampleTree());
    expect(md).toContain('# 订单中心');
    expect(md).toContain('## **[P1]** 正确密码登录成功');
    expect(md).toContain('- 前置条件：已注册用户');
    expect(md).toContain('- 步骤 1：打开登录页');
    expect(md).toContain('- 预期：提示密码错误');
  });
});

describe('Markdown decode', () => {
  it('标题+列表还原为树，字段行归入 props', () => {
    const md = [
      '# 订单中心',
      '',
      '## 登录模块',
      '',
      '- 前置条件：已注册用户',
      '- 步骤 1：打开登录页',
      '  - 预期：跳转首页',
      '',
      '### 嵌套路径',
      '',
      '- 深用例',
      '',
    ].join('\n');
    const { tree, warnings } = decodeMarkdown(md);
    expect(warnings).toEqual([]);
    expect(tree.text).toBe('订单中心');
    expect(tree.children![0]!.text).toBe('登录模块');
    expect(tree.children![0]!.props.precondition).toBe('已注册用户');
    expect(tree.children![0]!.props.steps).toEqual(['打开登录页']);
    expect(tree.children![0]!.props.expected).toBe('跳转首页');
    // 层级：订单中心 > 登录模块 > 嵌套路径 > 深用例
    const deep = tree.children![0]!.children![0]!.children![0]!;
    expect(deep.text).toBe('深用例');
  });

  it('roundtrip：encode → decode 语义不变', () => {
    const md = encodeMarkdown(sampleTree());
    const { tree } = decodeMarkdown(md);
    expect(tree.text).toBe('订单中心');
    expect(tree.children![0]!.children![0]!.props.priority).toBe('P1');
    expect(tree.children![0]!.children![0]!.props.steps).toEqual([
      '打开登录页',
      '输入正确账号密码',
      '点击登录',
    ]);
  });
});
