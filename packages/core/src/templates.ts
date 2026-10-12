/**
 * 内置导图模板与测试设计方法库。
 *
 * - 模板：新建导图时的预置结构（根 + 一级维度节点）。纯数据，无业务逻辑。
 * - 方法库（TEST_DESIGN_METHODS）：按测试方向整理的用例设计方法与检查点，
 *   供 AI 工具循环注入 system prompt 约束生成质量，也可用于前端展示。
 */

/** 模板节点定义（递归） */
export interface TemplateNode {
  type: string;
  text: string;
  props?: Record<string, unknown>;
  children?: TemplateNode[];
}

/** 导图模板 */
export interface MindTemplate {
  id: string;
  name: string;
  description: string;
  /** 模板适用方向（展示 + AI 约束选择用） */
  tags: string[];
  root: TemplateNode;
}

/**
 * 测试设计方法库：按方向给出设计方法与检查点。
 * key = 方向标识（与模板一级维度对应），value = AI 可读的结构化方法说明。
 */
export interface TestDesignMethod {
  /** 方向标识 */
  key: string;
  /** 展示名 */
  label: string;
  /** 该方向的测试目标（AI 生成时的目标约束） */
  goal: string;
  /** 推荐的设计方法（等价类/边界值等，AI 按此展开用例） */
  methods: string[];
  /** 容易遗漏的检查点（AI 必须覆盖） */
  checkpoints: string[];
}

export const TEST_DESIGN_METHODS: TestDesignMethod[] = [
  {
    key: 'functional',
    label: '功能测试',
    goal: '验证功能在正常路径下符合需求描述，输入→处理→输出正确',
    methods: [
      '等价类划分：有效/无效输入各取代表值',
      '场景法：按业务流程画出基本流 + 备选流，每条流一个用例',
      '判定表：多条件组合时列出条件桩与动作桩的全组合',
    ],
    checkpoints: ['主流程可达', '输出与需求一致', '状态变化正确'],
  },
  {
    key: 'boundary',
    label: '边界测试',
    goal: '在输入域的边缘处验证行为（缺陷最密集的区域）',
    methods: [
      '边界值分析：取 min、min+、nominal、max-、max 五点',
      '区间开闭性：上边界取值/越界一个单位',
      '空集合/单元素/满容量三种极端规模',
    ],
    checkpoints: ['最小值/最大值', '刚好越界', '0/空/null', '容量上限'],
  },
  {
    key: 'exception',
    label: '异常测试',
    goal: '验证非法输入、故障注入下的容错与恢复',
    methods: [
      '错误推测：凭经验枚举可能出错的输入与操作序列',
      '故障注入：断网/超时/服务不可用/脏数据',
      '重复/乱序/并发提交同一资源',
    ],
    checkpoints: ['报错文案明确', '不崩溃不挂死', '事务回滚', '可恢复'],
  },
  {
    key: 'security',
    label: '安全测试',
    goal: '验证鉴权、输入净化与敏感数据保护',
    methods: [
      '未登录/越权访问（水平越权：改他人 ID；垂直越权：低权限访问高权限功能）',
      '注入类：SQL/命令/XSS/路径穿越的典型 payload',
      '敏感信息泄漏：日志、响应体、错误栈',
    ],
    checkpoints: ['默认拒绝', '输入过滤', '会话过期', '密码不明文'],
  },
  {
    key: 'performance',
    label: '性能测试',
    goal: '验证负载下的响应时间、吞吐与资源占用',
    methods: [
      '基准：单用户关键路径耗时',
      '负载：预期并发下的 P95/P99 延迟',
      '压力：阶梯加压找拐点与恢复能力',
    ],
    checkpoints: ['响应时间阈值', '无内存泄漏', '慢查询', '降级策略'],
  },
  {
    key: 'compatibility',
    label: '兼容性测试',
    goal: '验证不同环境组合下行为一致',
    methods: [
      '浏览器矩阵：Chrome/Safari/Firefox/Edge 主流版本',
      '分辨率与移动端适配',
      '数据兼容：旧版本数据的升级迁移',
    ],
    checkpoints: ['核心流程全矩阵可走通', '样式不错位', '旧数据可迁移'],
  },
];

/** 按方向 key 找方法（找不到返回 undefined） */
export function findMethod(key: string): TestDesignMethod | undefined {
  return TEST_DESIGN_METHODS.find((m) => m.key === key);
}

/** 通用功能模块的一级维度（测试用例模板的标准骨架） */
const TEST_DIMENSIONS: TemplateNode[] = [
  {
    type: 'folder',
    text: '功能验证',
    props: { method: 'functional' },
    children: [{ type: 'case', text: '示例：主流程正常路径', props: { priority: 'P0' } }],
  },
  {
    type: 'folder',
    text: '边界与极限',
    props: { method: 'boundary' },
    children: [{ type: 'case', text: '示例：输入最小/最大值', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '异常与容错',
    props: { method: 'exception' },
    children: [{ type: 'case', text: '示例：非法输入的报错', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '安全与权限',
    props: { method: 'security' },
    children: [{ type: 'case', text: '示例：未登录访问拦截', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '性能与容量',
    props: { method: 'performance' },
    children: [{ type: 'case', text: '示例：单接口 P95 耗时', props: { priority: 'P2' } }],
  },
  {
    type: 'folder',
    text: '兼容性与适配',
    props: { method: 'compatibility' },
    children: [{ type: 'case', text: '示例：主流浏览器主流程', props: { priority: 'P2' } }],
  },
];

/** 内置模板列表 */
export const BUILTIN_TEMPLATES: MindTemplate[] = [
  {
    id: 'blank',
    name: '空白导图',
    description: '只有根节点，自由组织',
    tags: ['通用'],
    root: { type: 'folder', text: '根节点' },
  },
  {
    id: 'testcase',
    name: '测试用例模板',
    description: '按 6 大测试维度组织：功能/边界/异常/安全/性能/兼容性，每个维度标注了设计方法，AI 生成用例时自动遵循',
    tags: ['测试', '推荐'],
    root: { type: 'folder', text: '根节点', children: TEST_DIMENSIONS },
  },
];

/** 按 id 取模板 */
export function findTemplate(id: string): MindTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/**
 * 把方法库渲染成 AI system prompt 的约束段落（无模板时返回通用段落）。
 * dimensions：当前导图一级节点标注的 method keys（AI 只需针对存在的维度展开）。
 */
export function renderMethodPrompt(dimensions: string[]): string {
  if (!dimensions.length) {
    return [
      '当前导图未标注测试维度。生成用例时请综合运用：等价类划分、边界值分析、场景法、错误推测，',
      '覆盖正常流/边界/异常/权限四类，并给每条用例标注 P0-P3 优先级。',
    ].join('\n');
  }
  const matched = dimensions.map((k) => findMethod(k)).filter((m): m is TestDesignMethod => !!m);
  if (!matched.length) {
    // 标注了维度但都不在方法库中：回退通用段
    return renderMethodPrompt([]);
  }
  const parts: string[] = [];
  parts.push('当前导图按测试维度组织，各维度节点带 method 标注。生成用例时必须遵循对应维度的方法与检查点：');
  for (const m of matched) {
    parts.push(
      [
        `【${m.label}】目标：${m.goal}`,
        `  设计方法：${m.methods.join('；')}`,
        `  必查点：${m.checkpoints.join('、')}`,
      ].join('\n'),
    );
  }
  parts.push('每条用例 props 带 priority（P0-P3）；能写 steps/expected 的写全。');
  return parts.join('\n');
}

/**
 * 从模板创建文档数据（根名 = 文档名，一次性快照；method 标注随节点保留）。
 * templateId 未知时回退空白模板。
 */
export function buildTemplateDoc(templateId: string, title: string): {
  version: 1;
  meta: { title: string; updatedAt: string };
  tree: import('./types.js').MindNode;
  annotations: never[];
} {
  const t = findTemplate(templateId) ?? BUILTIN_TEMPLATES[0]!;
  const clone = (n: TemplateNode): import('./types.js').MindNode => ({
    id: '',
    type: n.type,
    text: n.text,
    props: { ...(n.props ?? {}) },
    children: (n.children ?? []).map(clone),
  });
  const tree = clone(t.root);
  tree.text = title; // 根名 = 文档名
  return {
    version: 1,
    meta: { title, updatedAt: new Date().toISOString() },
    tree,
    annotations: [],
  };
}
