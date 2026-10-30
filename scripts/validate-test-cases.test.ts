import { describe, expect, it } from 'vitest';
import { validateDocument, validateFile, collectFiles } from '../.agents/skills/test-case-designer/scripts/validate-test-cases.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let seq = 0;
function node(type, text, children = [], props = {}) {
  return { id: `n_${String(++seq).padStart(4, '0')}`, type, text, props, children };
}

function caseNode(text, props = {}) {
  return { id: `n_${String(++seq).padStart(4, '0')}`, type: 'case', text, props, children: [] };
}

function goodCase(text, priority, extra = {}) {
  const id = String(++seq).padStart(3, '0');
  return caseNode(text, {
    priority,
    precondition: '具备文档管理权限且测试数据已准备',
    steps: ['打开文档管理页面', '选择文件并提交', '核对页面、接口记录和文件内容'],
    expected: '1. 页面显示提交成功；2. 业务记录唯一；3. 下载内容与原文件一致',
    caseType: 'functional',
    testLevel: 'e2e',
    remark: `CASE-${id} · 来源：需求 §3.2 · 测试条件：TCND-${id} · 失败影响：核心资料不可用`,
    ...extra,
  });
}

function docWith(cases, folderName = '用户端') {
  const folder = node('folder', folderName, cases);
  const root = node('folder', '测试文档', [folder]);
  return { version: 1, meta: { title: '测试文档', updatedAt: new Date().toISOString() }, tree: root, annotations: [] };
}

function codes(list) {
  return list.map((item) => item.code);
}

describe('test-case-designer validator', () => {
  it('结构、字段和追溯完整的文档默认无 ERROR/WARN', () => {
    seq = 0;
    const doc = docWith([
      goodCase('【有效文件】提交文档｜记录唯一且内容可读取', 'P1'),
      goodCase('【服务短暂中断】重试提交｜不产生重复记录', 'P2', {
        caseType: 'exception',
        steps: ['提交过程中模拟服务中断', '恢复服务后重新提交', '核对记录数量和文件内容'],
        expected: '1. 用户可重试；2. 业务记录和文件均不重复；3. 内容完整',
      }),
    ]);
    const result = validateDocument(doc);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.stats.traceabilityRatio).toBe(1);
  });

  it('发现高优先级缺字段、非法枚举、重复标题和无意义空分组', () => {
    seq = 0;
    const badP0 = caseNode('【管理员】提交配置｜保存成功', { priority: 'P0', remark: '来源：需求' });
    const invalidPriority = goodCase('重复标题｜返回结果', 'P9');
    const duplicateA = goodCase('重复标题｜返回结果', 'P2');
    const duplicateB = goodCase('重复标题｜返回结果', 'P3');
    const emptyGroup = node('folder', '未使用分组');
    const doc = docWith([badP0, invalidPriority, duplicateA, duplicateB]);
    doc.tree.children.push(emptyGroup);

    const result = validateDocument(doc);
    expect(codes(result.errors)).toEqual(expect.arrayContaining(['case.steps-empty', 'case.expected-empty', 'case.priority-invalid']));
    expect(codes(result.warnings)).toEqual(expect.arrayContaining(['duplicate.title', 'hierarchy.empty-group']));
  });

  it('有详情的准备节点不按空业务分组报警', () => {
    seq = 0;
    const doc = docWith([goodCase('【有效输入】保存配置｜配置立即生效', 'P2')]);
    doc.tree.children.push(node('folder', '测试资料', [], { detail: '准备两个具备不同权限的测试账号。' }));
    const result = validateDocument(doc);
    expect(codes(result.warnings)).not.toContain('hierarchy.empty-group');
  });

  it('默认提示异常 P0 占比和全 P0 分组，并允许专项策略显式关闭', () => {
    seq = 0;
    const cases = Array.from({ length: 5 }, (_, index) => goodCase(`高风险场景 ${index + 1}｜阻止数据损坏`, 'P0'));
    const defaultResult = validateDocument(docWith(cases, '管理端'));
    expect(codes(defaultResult.warnings)).toEqual(expect.arrayContaining(['priority.p0-ratio', 'priority.branch-all-p0']));

    const policyResult = validateDocument(docWith(cases, '管理端'), {
      maxP0Ratio: null,
      warnAllP0Branches: false,
    });
    expect(codes(policyResult.warnings)).not.toContain('priority.p0-ratio');
    expect(codes(policyResult.warnings)).not.toContain('priority.branch-all-p0');
    const branchWarning = defaultResult.warnings.find((item) => item.code === 'priority.branch-all-p0');
    expect(branchWarning?.message).toContain('管理端');
    expect(branchWarning?.message).not.toContain('n_');
  });

  it('低风险专项默认不强制 P0/P1，显式策略可以要求', () => {
    seq = 0;
    const doc = docWith([goodCase('【帮助文案】打开说明｜展示完整文本', 'P2')]);
    expect(codes(validateDocument(doc).warnings)).not.toContain('priority.no-p0');
    expect(codes(validateDocument(doc, { requireP0: true, requireP1: true }).warnings)).toEqual(
      expect.arrayContaining(['priority.no-p0', 'priority.no-p1']),
    );
  });

  it('P0 必须说明影响、范围、恢复和发布决策，禁止用“失败禁止发布”循环论证', () => {
    seq = 0;
    const generic = goodCase('存量切换失败｜停止发布', 'P0', {
      remark: 'CASE-P0-001 · 来源：需求 §3.2 · 测试条件：TCND-P0-001 · 失败禁止发布',
    });
    const evidenced = goodCase('存量对象损坏｜停止发布', 'P0', {
      remark:
        'CASE-P0-002 · 来源：需求 §3.2 · 测试条件：TCND-P0-002 · 影响：存量对象损坏；范围：全部升级企业；恢复：切换后无法重试、回滚或绕行；决策：无损升级是本次发布承诺',
    });
    const result = validateDocument(docWith([generic, evidenced]), {
      maxP0Ratio: null,
      warnAllP0Branches: false,
    });
    const evidenceWarnings = result.warnings.filter((item) => item.code === 'priority.p0-evidence-missing');
    expect(evidenceWarnings).toHaveLength(1);
    expect(evidenceWarnings[0]?.nodeId).toBe(generic.id);
  });

  it('检查全部文本字段中的乱码、未解码实体和截断标题', () => {
    seq = 0;
    const corrupted = goodCase('上传附件���校验摘要', 'P2', {
      precondition: '企业已启用存储&amp;已准备文件',
    });
    const truncated = goodCase('准备迁移企业…', 'P2');
    const result = validateDocument(docWith([corrupted, truncated]));
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining(['text.corrupted-encoding', 'text.truncated-title']),
    );
  });

  it('允许在预期中验证对外契约标识，但仍提示标题中的实现标识', () => {
    seq = 0;
    const contractCase = goodCase('【无权限】提交请求｜返回拒绝结果', 'P1', {
      expected: '接口返回 403 和 ACCESS_DENIED，业务数据保持不变',
      caseType: 'security',
      testLevel: 'api',
    });
    const implementationTitle = goodCase('验证 RESOURCE_PENDING｜显示处理中', 'P2');
    const result = validateDocument(docWith([contractCase, implementationTitle]));
    expect(codes(result.warnings)).not.toContain('case.expected-implementation-identifier');
    expect(codes(result.warnings)).toContain('case.title-implementation-identifier');
  });

  it('标题中的单个内部模型词、字段标识和协议词必须改写为业务语言', () => {
    seq = 0;
    const doc = docWith([
      goodCase('Assignment 与 Location 不一致｜以 Assignment 为准', 'P2'),
      goodCase('更新 credential_version｜旧检测失效', 'P2'),
      goodCase('调用 PATCH 保存配置｜返回 200', 'P2'),
    ]);
    const result = validateDocument(doc);
    expect(result.warnings.filter((item) => item.code === 'case.title-implementation-identifier')).toHaveLength(3);
  });

  it('提示过长标题和重复父级业务域，保证测试意图可直接阅读', () => {
    seq = 0;
    const longTitle =
      '【文件上传】选择文件并提交，上传完成后页面显示成功且业务记录、对象内容和审计记录全部一致，' +
      '同时核对历史列表、统计数据、下载内容、文件摘要、更新时间、操作人员和后续使用结果均符合该业务场景的主要验收要求，' +
      '并确认刷新页面、重新登录、重复提交、异常恢复和再次下载后仍然保持相同结果且不会产生重复数据';
    const root = node('folder', '测试文档', [
      node('folder', '文件上传', [
        goodCase(longTitle, 'P2'),
      ]),
    ]);
    const result = validateDocument({ version: 1, meta: { title: '测试文档' }, tree: root, annotations: [] });
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining(['case.title-too-long', 'case.title-redundant-parent']),
    );
  });

  it('相似度比较限定在同一一级分支，减少跨场景误报', () => {
    seq = 0;
    const shared = ['打开目标页面', '提交相同测试数据', '核对页面和业务记录'];
    const root = node('folder', '测试文档', [
      node('folder', '用户端', [goodCase('用户提交｜保存成功', 'P2', { steps: shared })]),
      node('folder', '管理端', [goodCase('管理员提交｜保存成功', 'P2', { steps: shared })]),
    ]);
    const result = validateDocument({ version: 1, meta: { title: '测试文档' }, tree: root, annotations: [] });
    expect(codes(result.warnings)).not.toContain('duplicate.similar-steps');
  });

  it('缺少稳定 ID、来源或测试条件时分别提示', () => {
    seq = 0;
    const result = validateDocument(docWith([
      goodCase('缺少追溯｜需要补齐', 'P2', { remark: '普通说明' }),
    ]));
    expect(codes(result.warnings)).toEqual(expect.arrayContaining([
      'trace.case-id-missing',
      'trace.source-missing',
      'trace.condition-id-missing',
    ]));
  });

  it('区分测试类型和测试层级，并提示旧版 api/ui caseType', () => {
    seq = 0;
    const legacy = goodCase('旧版接口用例｜返回成功', 'P2', {
      caseType: 'api',
      testLevel: undefined,
    });
    const invalid = goodCase('非法层级用例｜返回成功', 'P2', { testLevel: 'browser' });
    const result = validateDocument(docWith([legacy, invalid]));
    expect(codes(result.warnings)).toEqual(expect.arrayContaining(['case.type-legacy-level', 'case.level-missing']));
    expect(codes(result.errors)).toContain('case.level-invalid');
  });

  it('validateFile 处理解析失败；collectFiles 递归收集 .mindmap.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-validator-'));
    try {
      writeFileSync(join(dir, 'bad.mindmap.json'), '{not json');
      writeFileSync(join(dir, 'ok.mindmap.json'), JSON.stringify(docWith([])));
      writeFileSync(join(dir, 'ignore.json'), '{}');
      expect(codes(validateFile(join(dir, 'bad.mindmap.json')).errors)).toContain('doc.parse');
      expect(collectFiles([dir]).map((path) => path.split('/').pop())).toEqual(['bad.mindmap.json', 'ok.mindmap.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
