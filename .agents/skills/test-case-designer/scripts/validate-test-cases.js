#!/usr/bin/env node
/**
 * test-case-designer 质量门禁：对 ai-mind-map 的 .mindmap.json 做确定性检查。
 *
 * 检查内容：
 * - 结构：空分组、层级过深、目录中的疑似内部实现标识
 * - 字段：标题/步骤/预期/优先级/用例类型/备注（P0/P1 更严格）
 * - 质量：模板化步骤、不可判定预期、疑似内部实现标识、标题多判定点
 * - 重复：重复标题、高度相似步骤
 * - 优先级：P0/P1 失败影响说明；默认提示异常 P0 占比和全 P0 分组
 *
 * 用法：
 *   node .agents/skills/test-case-designer/scripts/validate-test-cases.js <file-or-dir> [...]
 *        [--strict] [--json] [--max-depth=5] [--max-p0-ratio=0.35]
 *        [--require-p0] [--require-p1] [--warn-all-p0-branches]
 *        [--max-duplicate-ratio=0.05] [--quiet]
 *
 * 退出码：有 ERROR → 1；--strict 且存在 WARN → 1；否则 0。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_OPTIONS = {
  /** 文件夹最大深度；null 表示不检查 */
  maxFolderDepth: 5,
  /** P0 占比复核阈值；只是 WARN 探针，不用于反向分配优先级 */
  maxP0Ratio: 0.35,
  /** 是否要求文档至少包含一个 P0 / P1 */
  requireP0: false,
  requireP1: false,
  /** 是否提示同一直接分组全部为 P0 */
  warnAllP0Branches: true,
  /** 重复标题占比阈值 */
  maxDuplicateRatio: 0.05,
  /** 相似步骤判定阈值（char bigram Jaccard） */
  similarity: 0.92,
  /** 参与相似度检查的最大用例数，避免超大文档 O(n²) 过慢 */
  similarityLimit: 800,
  /** 同一测试条件下的用例数达到该值时提示“条件可能过粗” */
  maxCasesPerCondition: 4,
};

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const CASE_TYPES = [
  'functional',
  'boundary',
  'exception',
  'security',
  'performance',
  'compatibility',
  'data',
  'workflow',
  'reliability',
  'accessibility',
  'localization',
];
const LEGACY_LEVEL_CASE_TYPES = ['api', 'ui'];
const TEST_LEVELS = ['ui', 'api', 'service', 'database', 'contract', 'e2e'];
const VAGUE_EXPECTED = /功能正常|符合预期|无异常|没有问题|表现正常|正确无误|正常显示$/;
const TEMPLATE_STEP = /执行对应操作|按需求操作|按用例操作|执行相关操作|验证功能|测试功能|查看结果即可|按预期操作/;
const IMPACT_HINT = /影响|阻塞|不可用|损坏|越权|泄露|隔离|恢复|发布|资损|不可逆|风险|严重/;
const P0_EVIDENCE_HINTS = [
  ['影响', /(?:影响|损失)\s*[：:]/],
  ['范围', /范围\s*[：:]/],
  ['恢复', /(?:恢复|绕行|回滚|降级)\s*[：:]/],
  ['决策', /(?:决策|发布承诺)\s*[：:]/],
];
const CORRUPTED_TEXT = /\uFFFD|(?:Ã.|Â.|â€¦|ðŸ)|&#x?[0-9a-f]+;|&(?:amp|lt|gt|quot);/i;
const TRUNCATED_TEXT = /(?:…|\.\.\.)\s*$/;
const SOURCE_HINT = /来源\s*[：:]|requirement|acceptance|reference|契约|需求|验收|缺陷/i;
const CASE_ID_HINT = /\bCASE-[A-Z0-9_-]+\b/i;
const CONDITION_ID_HINT = /\bTCND-[A-Z0-9_-]+\b/i;
const MULTI_POINT_TITLE = /[；;]/;
const TITLE_MAX_LENGTH = 100;

/** 从 remark 中提取 CASE-* ID；用于唯一性和追溯统计 */
function extractCaseId(remark) {
  const match = CASE_ID_HINT.exec(String(remark ?? ''));
  return match ? match[0] : null;
}

/** 从 remark 中提取 TCND-* ID；用于条件粒度统计 */
function extractConditionId(remark) {
  const match = CONDITION_ID_HINT.exec(String(remark ?? ''));
  return match ? match[0] : null;
}

const IMPLEMENTATION_IDENTIFIERS = [
  { label: '接口路径', pattern: /(?:^|\s)\/(?:api|v\d+)(?:\/|\b)/i },
  { label: '枚举常量', pattern: /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/ },
  { label: 'HTTP 方法与路径', pattern: /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\// },
  { label: 'HTTP 方法', pattern: /\b(?:GET|POST|PUT|PATCH|DELETE)\b/ },
  { label: 'HTTP 状态码', pattern: /(?:^|\D)[1-5]\d{2}(?:\D|$)/ },
  { label: '代码标识符', pattern: /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/i },
  { label: '权限标识', pattern: /\b[a-z][a-z0-9]*(?::[a-z0-9*_-]+)+\b/i },
  {
    label: '内部技术词',
    pattern:
      /\b(?:assignment|location|profile|campaign|revision|binding|credential|provider|capability|endpoint|bucket|region|offset|chunk|gateway|token|current|introspect|nonce|header|payload|streaming|cas|api|sdk|mcp|jwt|hmac|etag)\b/i,
  },
];

function findImplementationIdentifier(text) {
  return IMPLEMENTATION_IDENTIFIERS.find((entry) => entry.pattern.test(String(text ?? '')));
}

function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。；;、：:｜|【】[\]（）()"'“”‘’]/g, '');
}

function bigrams(s) {
  const t = normalize(s);
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function textOf(node) {
  return String(node?.text ?? '').trim();
}

function propsOf(node) {
  return (node?.props ?? {}) || {};
}

function stringFields(value, path = 'props', out = []) {
  if (typeof value === 'string') out.push({ field: path, value });
  else if (Array.isArray(value)) value.forEach((item, index) => stringFields(item, `${path}[${index}]`, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringFields(item, `${path}.${key}`, out);
  }
  return out;
}

function stepsOf(node) {
  const steps = propsOf(node).steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => String(s ?? '').trim()).filter(Boolean);
}

function firstLine(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function addIssue(list, code, message, caseNode) {
  list.push({
    code,
    message,
    nodeId: caseNode?.node?.id ?? undefined,
    title: caseNode ? firstLine(caseNode.node.text) : undefined,
  });
}

/**
 * 校验一个 MindDocument 对象。
 * @returns {{ errors: Array, warnings: Array, stats: object }}
 */
export function validateDocument(doc, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const errors = [];
  const warnings = [];
  const stats = {
    nodes: 0,
    cases: 0,
    folders: 0,
    priorities: { P0: 0, P1: 0, P2: 0, P3: 0 },
    missingPriority: 0,
    maxCaseDepth: 0,
    p0Ratio: 0,
    traceableCases: 0,
    traceabilityRatio: 0,
  };

  if (!doc || typeof doc !== 'object' || !doc.tree) {
    errors.push({ code: 'doc.invalid', message: '文档缺少 tree，无法校验' });
    return { errors, warnings, stats };
  }

  /** @type {Array<{node:any, depth:number, branch:string|null, ancestors:string[]}>} */
  const cases = [];
  /** @type {Array<{node:any, depth:number, path:string}>} */
  const folders = [];

  const walk = (node, depth, branch, ancestors) => {
    stats.nodes++;
    const fields = [{ field: 'text', value: textOf(node) }, ...stringFields(propsOf(node))];
    for (const field of fields) {
      if (CORRUPTED_TEXT.test(field.value)) {
        warnings.push({
          code: 'text.corrupted-encoding',
          nodeId: node.id,
          message: `字段 ${field.field} 包含乱码、替换字符或未解码实体`,
        });
      }
    }
    if (TRUNCATED_TEXT.test(textOf(node))) {
      warnings.push({
        code: 'text.truncated-title',
        nodeId: node.id,
        message: `标题「${firstLine(textOf(node))}」疑似保存了界面截断文本`,
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    if (node.type === 'case') {
      stats.cases++;
      stats.maxCaseDepth = Math.max(stats.maxCaseDepth, depth);
      cases.push({ node, depth, branch, ancestors });
    } else {
      stats.folders++;
      folders.push({ node, depth, path: [...ancestors, textOf(node)].join(' / ') });
    }
    for (const child of children) {
      walk(child, depth + 1, depth === 0 ? textOf(child) : branch, [...ancestors, textOf(node)]);
    }
  };
  walk(doc.tree, 0, null, []);

  // ---- 用例层级结构：e2e 断言仍应保持业务可见语言，技术契约细节下沉到低层级或备注 ----

  // 每个分组下的后代用例数（用于发现“有子目录但没有用例”的空分组）
  const descendantCases = new Map();
  const countCases = (node) => {
    if (node.type === 'case') return 1;
    let n = 0;
    for (const child of Array.isArray(node.children) ? node.children : []) n += countCases(child);
    descendantCases.set(node.id, n);
    return n;
  };
  countCases(doc.tree);

  // ---------- 目录检查 ----------
  for (const folder of folders) {
    const name = textOf(folder.node);
    const implementationIdentifier = findImplementationIdentifier(name);
    if (implementationIdentifier) {
      warnings.push({
        code: 'hierarchy.implementation-identifier',
        nodeId: folder.node.id,
        message: `目录名「${name}」包含疑似${implementationIdentifier.label}，应改为业务语言`,
      });
    }
    const props = propsOf(folder.node);
    const detail = String(props.detail ?? '').trim();
    const nodeRole = String(props.nodeRole ?? '').trim().toLowerCase();
    const auxiliary = Boolean(detail) || ['reference', 'setup', 'test-data', 'note'].includes(nodeRole);
    if (folder.depth > 0 && (descendantCases.get(folder.node.id) ?? 0) === 0 && !auxiliary) {
      warnings.push({
        code: 'hierarchy.empty-group',
        nodeId: folder.node.id,
        message: `空分组「${name}」下没有任何用例`,
      });
    }
  }

  // ---------- 用例检查 ----------
  /** @type {Map<string, Array>} */
  const titleGroups = new Map();
  const stepTexts = [];
  /** 同一 TCND 下的用例列表，用于检查条件粒度 */
  const conditionGroups = new Map();

  for (const item of cases) {
    const { node, depth } = item;
    const title = textOf(node);
    const props = propsOf(node);
    const priority = String(props.priority ?? '');
    const steps = stepsOf(node);
    const expected = String(props.expected ?? '').trim();
    const precondition = String(props.precondition ?? '').trim();
    const caseType = String(props.caseType ?? '').trim();
    const testLevel = String(props.testLevel ?? '').trim();
    const remark = String(props.remark ?? '').trim();
    const caseId = extractCaseId(remark);
    const conditionId = extractConditionId(remark);

    if (!title) addIssue(errors, 'case.title-empty', '用例标题为空', item);

    if (priority && !PRIORITIES.includes(priority)) {
      addIssue(errors, 'case.priority-invalid', `非法优先级「${priority}」（只允许 P0-P3）`, item);
    } else if (!priority) {
      stats.missingPriority++;
      addIssue(warnings, 'case.priority-missing', '未设置优先级', item);
    } else {
      stats.priorities[priority]++;
    }

    const strictTier = priority === 'P0' || priority === 'P1';
    if (!steps.length) {
      addIssue(strictTier ? errors : warnings, 'case.steps-empty', `${strictTier ? 'P0/P1' : '用例'}缺少可执行步骤`, item);
    } else if (steps.some((s) => TEMPLATE_STEP.test(s))) {
      addIssue(warnings, 'case.steps-template', '步骤包含模板化描述（如“执行对应操作/验证功能”）', item);
    }
    if (!expected) {
      addIssue(strictTier ? errors : warnings, 'case.expected-empty', `${strictTier ? 'P0/P1' : '用例'}缺少预期结果`, item);
    } else if (VAGUE_EXPECTED.test(expected)) {
      addIssue(warnings, 'case.expected-vague', '预期结果不可判定（如“功能正常/符合预期”）', item);
    }
    if (!precondition) {
      addIssue(warnings, 'case.precondition-empty', '前置条件为空；若确实无需前置请明确写“无”', item);
    }
    if (!caseType) {
      addIssue(warnings, 'case.type-missing', '未设置用例类型 caseType', item);
    } else if (LEGACY_LEVEL_CASE_TYPES.includes(caseType)) {
      addIssue(warnings, 'case.type-legacy-level', `caseType「${caseType}」是旧版层级写法；请迁移为 caseType=functional、testLevel=${caseType}`, item);
    } else if (!CASE_TYPES.includes(caseType)) {
      addIssue(errors, 'case.type-invalid', `非法用例类型「${caseType}」`, item);
    }
    if (!testLevel) {
      addIssue(warnings, 'case.level-missing', '未设置测试层级 testLevel', item);
    } else if (!TEST_LEVELS.includes(testLevel)) {
      addIssue(errors, 'case.level-invalid', `非法测试层级「${testLevel}」`, item);
    }
    if (!remark) {
      addIssue(warnings, 'case.remark-missing', '缺少备注、稳定用例 ID、事实来源和测试条件 ID', item);
    } else {
      const hasCaseId = CASE_ID_HINT.test(remark);
      const hasSource = SOURCE_HINT.test(remark);
      const hasConditionId = CONDITION_ID_HINT.test(remark);
      if (!hasCaseId) addIssue(warnings, 'trace.case-id-missing', '备注缺少稳定用例 ID（CASE-*）', item);
      if (!hasSource) addIssue(warnings, 'trace.source-missing', '备注缺少可定位的事实来源', item);
      if (!hasConditionId) addIssue(warnings, 'trace.condition-id-missing', '备注缺少测试条件 ID（TCND-*）', item);
      if (hasCaseId && hasSource && hasConditionId) stats.traceableCases++;
    }
    if (strictTier && remark && !IMPACT_HINT.test(remark)) {
      addIssue(warnings, 'case.impact-missing', 'P0/P1 备注未说明失败影响/定级依据', item);
    }
    if (priority === 'P0') {
      const missingEvidence = P0_EVIDENCE_HINTS.filter(([, pattern]) => !pattern.test(remark)).map(([label]) => label);
      if (missingEvidence.length) {
        addIssue(
          warnings,
          'priority.p0-evidence-missing',
          `P0 备注缺少${missingEvidence.join('、')}证据；仅写“失败禁止发布”不能证明 P0`,
          item,
        );
      }
    }

    if (title) {
      const parentName = item.ancestors.at(-1) ?? '';
      if (Array.from(title).length > TITLE_MAX_LENGTH) {
        addIssue(warnings, 'case.title-too-long', `标题超过 ${TITLE_MAX_LENGTH} 个字符，测试意图无法一眼识别；请把技术参数和次要断言移入详情`, item);
      }
      if (parentName && (title.startsWith(`【${parentName}】`) || title.startsWith(`[${parentName}]`))) {
        addIssue(warnings, 'case.title-redundant-parent', `标题重复父级分类「${parentName}」，应直接描述条件、动作和结果`, item);
      }
      const implementationIdentifier = findImplementationIdentifier(title);
      if (implementationIdentifier) {
        addIssue(warnings, 'case.title-implementation-identifier', `标题包含疑似${implementationIdentifier.label}，应改为业务措辞`, item);
      }
      if (MULTI_POINT_TITLE.test(title)) {
        addIssue(warnings, 'case.title-multi-point', '标题含多个分句，确认是否包含多个不可独立判定的测试点', item);
      }
      const key = normalize(title);
      if (!titleGroups.has(key)) titleGroups.set(key, []);
      titleGroups.get(key).push(item);
    }
    if (conditionId) {
      const group = conditionGroups.get(conditionId) ?? [];
      group.push(item);
      conditionGroups.set(conditionId, group);
    }
    item.caseId = caseId;
    item.conditionId = conditionId;
    if (opts.maxFolderDepth !== null && depth - 1 > opts.maxFolderDepth) {
      addIssue(
        warnings,
        'hierarchy.too-deep',
        `用例位于 ${depth - 1} 层文件夹下，超过建议值 ${opts.maxFolderDepth}；确认额外层级是否提高执行或查找效率`,
        item,
      );
    }

    stepTexts.push({ item, text: steps.join('\n') + '\n' + expected });
  }

  // 重复标题
  let duplicateCases = 0;
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue;
    duplicateCases += group.length - 1;
    warnings.push({
      code: 'duplicate.title',
      nodeId: group[0].node.id,
      message: `重复标题 ${group.length} 次：「${firstLine(group[0].node.text)}」`,
    });
  }

  // 测试条件粒度：同一 TCND 下用例过多，通常说明条件停留在模块级而不是“可独立验证的行为”。

  // 稳定用例 ID 唯一性：同一 CASE-ID 复用到不同用例会直接破坏追溯链，属于 ERROR。
  const caseIdGroups = new Map();
  for (const item of cases) {
    if (!item.caseId) continue;
    const group = caseIdGroups.get(item.caseId) ?? [];
    group.push(item);
    caseIdGroups.set(item.caseId, group);
  }
  for (const [caseId, group] of caseIdGroups) {
    if (group.length < 2) continue;
    const paths = group.map((item) => [...item.ancestors, item.node.text].join(' / '));
    errors.push({
      code: 'trace.case-id-duplicate',
      nodeId: group[0].node.id,
      message: `稳定用例 ID「${caseId}」被 ${group.length} 条用例复用：${paths
        .map((path) => `「${firstLine(path, 40)}」`)
        .join('、')}；每条用例必须有唯一 CASE-*`,
    });
  }

  // 测试条件粒度：同一 TCND 下用例过多，通常说明条件停留在模块级而不是“可独立验证的行为”。
  for (const [conditionId, group] of conditionGroups) {
    if (group.length <= opts.maxCasesPerCondition) continue;
    const paths = [...new Set(group.map((item) => item.ancestors.join(' / ')))];
    warnings.push({
      code: 'trace.condition-too-broad',
      nodeId: group[0].node.id,
      message: `测试条件「${conditionId}」下有 ${group.length} 条用例，可能停留在模块级而非可独立验证的行为；` +
        `请拆分为更细测试条件，并保留用例间输入/状态/层级差异：${paths
          .map((path) => `「${firstLine(path, 30)}」`)
          .slice(0, 3)
          .join('、')}${paths.length > 3 ? ' 等' : ''}`,
    });
  }
  if (stats.cases >= 5 && duplicateCases / stats.cases > opts.maxDuplicateRatio) {
    warnings.push({
      code: 'duplicate.ratio',
      message: `重复标题占比 ${(duplicateCases / stats.cases * 100).toFixed(1)}% 超过阈值 ${(opts.maxDuplicateRatio * 100).toFixed(0)}%`,
    });
  }

  // 高度相似步骤（限制规模，避免 O(n²) 过慢）
  if (stepTexts.length >= 2 && stepTexts.length <= opts.similarityLimit) {
    let reported = 0;
    for (let i = 0; i < stepTexts.length && reported < 8; i++) {
      const a = bigrams(stepTexts[i].text);
      if (a.size < 8) continue;
      for (let j = i + 1; j < stepTexts.length && reported < 8; j++) {
        const b = bigrams(stepTexts[j].text);
        if (b.size < 8) continue;
        if (stepTexts[i].item.branch === stepTexts[j].item.branch && jaccard(a, b) >= opts.similarity) {
          reported++;
          warnings.push({
            code: 'duplicate.similar-steps',
            nodeId: stepTexts[j].item.node.id,
            message: `步骤与「${firstLine(stepTexts[i].item.node.text, 30)}」高度相似（可能是复制未改内容）`,
          });
        }
      }
    }
  }

  // ---------- 优先级分布 ----------
  const totalCases = stats.cases;
  stats.p0Ratio = totalCases ? stats.priorities.P0 / totalCases : 0;
  stats.traceabilityRatio = totalCases ? stats.traceableCases / totalCases : 0;
  if (opts.maxP0Ratio !== null && totalCases >= 5 && stats.p0Ratio > opts.maxP0Ratio) {
    warnings.push({
      code: 'priority.p0-ratio',
      message: `P0 占比 ${(stats.p0Ratio * 100).toFixed(1)}% 超过阈值 ${(opts.maxP0Ratio * 100).toFixed(0)}%（确认是否大量无理由 P0）`,
    });
  }
  if (opts.requireP0 && totalCases > 0 && stats.priorities.P0 === 0) {
    warnings.push({ code: 'priority.no-p0', message: '当前策略要求至少一个 P0，但文档没有 P0' });
  }
  if (opts.requireP1 && totalCases > 0 && stats.priorities.P1 === 0) {
    warnings.push({ code: 'priority.no-p1', message: '当前策略要求至少一个 P1，但文档没有 P1' });
  }

  // 同一直接业务分组全部 P0；用完整路径作 key，避免同名分组合并。
  const branchCases = new Map();
  for (const item of cases) {
    const parentPath = item.ancestors.slice(1).join(' / ');
    if (!parentPath) continue;
    const list = branchCases.get(parentPath) ?? [];
    list.push(item);
    branchCases.set(parentPath, list);
  }
  for (const [branch, list] of branchCases) {
    if (opts.warnAllP0Branches && list.length >= 3 && list.every((it) => String(propsOf(it.node).priority ?? '') === 'P0')) {
      warnings.push({
        code: 'priority.branch-all-p0',
        message: `同一业务分支（${firstLine(branch, 30)}）下 ${list.length} 条用例全部为 P0，需重新审视定级`,
      });
    }
  }

  // 文档无用例
  if (totalCases === 0) {
    warnings.push({ code: 'doc.no-cases', message: '文档没有任何用例' });
  }

  return { errors, warnings, stats };
}

/** 读取并校验单个文件 */
export function validateFile(file, options = {}) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      file,
      errors: [{ code: 'doc.parse', message: `无法读取/解析 JSON：${e instanceof Error ? e.message : String(e)}` }],
      warnings: [],
      stats: { nodes: 0, cases: 0, folders: 0, priorities: { P0: 0, P1: 0, P2: 0, P3: 0 }, missingPriority: 0, maxCaseDepth: 0, p0Ratio: 0, traceableCases: 0, traceabilityRatio: 0 },
    };
  }
  return { file, ...validateDocument(doc, options) };
}

/** 收集输入路径下的 .mindmap.json（目录递归） */
export function collectFiles(inputs) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (name.startsWith('.')) continue;
        walk(join(p, name));
      }
    } else if (extname(p) === '.json' && p.endsWith('.mindmap.json')) {
      out.push(p);
    }
  };
  for (const input of inputs) walk(input);
  return out.sort();
}

export function formatResult(result) {
  const lines = [];
  lines.push(result.file);
  const s = result.stats;
  lines.push(
    `  节点 ${s.nodes} · 用例 ${s.cases} · P0 ${s.priorities.P0} / P1 ${s.priorities.P1} / P2 ${s.priorities.P2} / P3 ${s.priorities.P3}` +
      (s.cases ? ` · P0 占比 ${(s.p0Ratio * 100).toFixed(1)}% · 可追溯 ${(s.traceabilityRatio * 100).toFixed(1)}%` : ''),
  );
  for (const e of result.errors) {
    lines.push(`  ✖ ERROR ${e.code}: ${e.message}${e.title ? ` —「${e.title}」` : ''}${e.nodeId ? ` [${e.nodeId}]` : ''}`);
  }
  for (const w of result.warnings) {
    lines.push(`  ⚠ WARN ${w.code}: ${w.message}${w.title ? ` —「${w.title}」` : ''}${w.nodeId ? ` [${w.nodeId}]` : ''}`);
  }
  return lines.join('\n');
}

function parseFlags(argv) {
  const options = { ...DEFAULT_OPTIONS };
  const files = [];
  let strict = false;
  let json = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--strict') strict = true;
    else if (arg === '--json') json = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node validate-test-cases.js <file-or-dir> [...] [--strict] [--json] [--max-depth=5] [--max-p0-ratio=0.35] [--require-p0] [--require-p1] [--warn-all-p0-branches] [--max-duplicate-ratio=0.05] [--quiet]');
      process.exit(0);
    } else if (arg === '--require-p0') options.requireP0 = true;
    else if (arg === '--require-p1') options.requireP1 = true;
    else if (arg === '--warn-all-p0-branches') options.warnAllP0Branches = true;
    else if (arg.startsWith('--max-depth=')) options.maxFolderDepth = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-p0-ratio=')) options.maxP0Ratio = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-duplicate-ratio=')) options.maxDuplicateRatio = Number(arg.split('=')[1]);
    else if (arg.startsWith('--similarity=')) options.similarity = Number(arg.split('=')[1]);
    else if (arg.startsWith('--')) {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    } else files.push(arg);
  }
  return { files, strict, json, quiet, options };
}

export function main(argv = process.argv.slice(2)) {
  const { files, strict, json, quiet, options } = parseFlags(argv);
  if (!files.length) {
    console.error('请传入 .mindmap.json 文件或目录，例如：node validate-test-cases.js mindmaps/');
    return 2;
  }
  let targets;
  try {
    targets = collectFiles(files);
  } catch (e) {
    console.error(`路径无效：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!targets.length) {
    console.error('没有找到 *.mindmap.json 文件');
    return 2;
  }
  const results = targets.map((f) => validateFile(f, options));
  const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
  const totalWarnings = results.reduce((n, r) => n + r.warnings.length, 0);
  const totalCases = results.reduce((n, r) => n + r.stats.cases, 0);

  if (json) {
    console.log(JSON.stringify({ results, summary: { files: results.length, cases: totalCases, errors: totalErrors, warnings: totalWarnings } }, null, 2));
  } else if (!quiet) {
    for (const result of results) console.log(formatResult(result) + '\n');
    console.log(`汇总：${results.length} 个文件 · ${totalCases} 条用例 · ${totalErrors} ERROR · ${totalWarnings} WARN`);
    console.log(totalErrors ? '结论：存在 ERROR，需修复后重跑' : strict && totalWarnings ? '结论：strict 模式下 WARN 视为失败' : '结论：通过结构/字段/优先级门禁');
  }
  return totalErrors > 0 || (strict && totalWarnings > 0) ? 1 : 0;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) process.exit(main());
