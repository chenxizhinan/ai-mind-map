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
  {
    key: 'api',
    label: '接口测试',
    goal: '验证 API 的契约、参数校验与状态码语义（前后端分离项目的重心）',
    methods: [
      '契约校验：请求/响应字段逐个验证类型、必填、默认值',
      '参数组合：必填缺失、类型错误、超长、特殊字符、枚举外值',
      '状态码语义：2xx/4xx/5xx 与业务错误码一一对应',
      '幂等性：同一请求重复提交的结果一致（PUT/DELETE/支付类 POST）',
      '版本兼容：旧版本客户端调用新接口的向后兼容',
    ],
    checkpoints: ['错误码表齐全', '分页边界', '批量上限', '幂等', '响应时间'],
  },
  {
    key: 'data',
    label: '数据与持久化测试',
    goal: '验证数据写入、读取、一致性、并发与迁移的正确性',
    methods: [
      'CRUD 全路径：增删改查逐个验证落库结果',
      '并发写：同一记录并发更新（乐观锁/悲观锁行为）',
      '事务边界：中途失败时的回滚完整性',
      '数据迁移：旧结构 → 新结构的字段映射与损耗',
      '时区与编码：跨时区时间存储、emoji/多字节字符',
    ],
    checkpoints: ['无脏数据', '唯一约束生效', '软删不出现于查询', '迁移可回滚'],
  },
  {
    key: 'ui',
    label: '前端交互测试',
    goal: '验证界面交互、状态反馈与用户体验细节',
    methods: [
      '控件状态：默认值/禁用态/加载态/空态/错误态五态齐全',
      '交互序列：快速重复点击、输入中途切换、返回后状态保持',
      '表单校验：失焦即校验、错误定位、提交禁用防重复',
      '文案与展示：超长截断、多语言占位、数字/日期本地化格式',
    ],
    checkpoints: ['加载与空态', '错误就近提示', '防重复提交', '键盘可达'],
  },
  {
    key: 'workflow',
    label: '业务流程测试',
    goal: '验证跨模块、跨角色的端到端业务流（订单/审批/状态机类）',
    methods: [
      '状态机遍历：合法迁移逐条走，非法迁移逐条拒',
      '角色路径：每个角色 × 每个状态的行为矩阵',
      '端到端串联：从触发到终态的全链路（含通知/对账等旁路）',
      '逆向流程：取消/退回/撤回对已产生数据的影响',
    ],
    checkpoints: ['终态可达', '非法迁移被拒', '旁路数据一致', '逆向可回退'],
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
    children: [{ type: 'case', text: '示例：填写有效账号密码后点击登录按钮，跳转到工作台', props: { priority: 'P0' } }],
  },
  {
    type: 'folder',
    text: '边界与极限',
    props: { method: 'boundary' },
    children: [{ type: 'case', text: '示例：输入框填入最大允许长度的字符后保存，保存成功', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '异常与容错',
    props: { method: 'exception' },
    children: [{ type: 'case', text: '示例：手机号输入框填入字母后点击提交，提示格式错误', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '安全与权限',
    props: { method: 'security' },
    children: [{ type: 'case', text: '示例：未登录状态直接访问订单页 URL，跳转到登录页', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '性能与容量',
    props: { method: 'performance' },
    children: [{ type: 'case', text: '示例：单用户连续请求订单列表接口 100 次，P95 耗时低于 200ms', props: { priority: 'P2' } }],
  },
  {
    type: 'folder',
    text: '兼容性与适配',
    props: { method: 'compatibility' },
    children: [{ type: 'case', text: '示例：在 Safari 浏览器完成一次完整下单流程，行为与 Chrome 一致', props: { priority: 'P2' } }],
  },
];

/** 接口测试模板的一级维度 */
const API_DIMENSIONS: TemplateNode[] = [
  {
    type: 'folder',
    text: '契约与参数校验',
    props: { method: 'api' },
    children: [{ type: 'case', text: '示例：必填参数缺失返回 400', props: { priority: 'P0' } }],
  },
  {
    type: 'folder',
    text: '状态码与错误码',
    props: { method: 'api' },
    children: [{ type: 'case', text: '示例：资源不存在返回 404 与业务码', props: { priority: 'P0' } }],
  },
  {
    type: 'folder',
    text: '鉴权与越权',
    props: { method: 'security' },
    children: [{ type: 'case', text: '示例：无 token 访问返回 401', props: { priority: 'P0' } }],
  },
  {
    type: 'folder',
    text: '幂等与并发',
    props: { method: 'data' },
    children: [{ type: 'case', text: '示例：重复提交仅生效一次', props: { priority: 'P1' } }],
  },
  {
    type: 'folder',
    text: '性能基线',
    props: { method: 'performance' },
    children: [{ type: 'case', text: '示例：单接口 P95 < 200ms', props: { priority: 'P2' } }],
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
  {
    id: 'api-test',
    name: '接口测试模板',
    description: '面向前后端分离项目：契约/状态码/鉴权/幂等/性能基线，配合接口设计方法约束 AI 生成',
    tags: ['接口'],
    root: { type: 'folder', text: '根节点', children: API_DIMENSIONS },
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
  parts.push(
    [
      '树的结构必须多级拆分，严禁在维度下直接平铺用例：',
      '第 1 级 = 测试维度（已有，带 method 标注，不要改动）；',
      '第 2 级 = 功能点（被测对象的功能模块，如"登录""订单创建"，一个 folder 对应一个功能点）；',
      '第 3 级 = 测试点（该功能点下按设计方法拆出的具体检验项，如"密码长度边界""并发提交"，folder）；',
      '第 4 级 = 用例（case，每个测试点下 2-6 条，props 带 priority/steps/expected）。',
      '即：维度 → 功能点 → 测试点 → 用例。add_subtree 时按此层级一次提交整棵子树，',
      '用 query_tree 确认维度节点 id 后，把"功能点→测试点→用例"整棵挂到对应维度下。',
      '',
      '命名规范（硬性）：',
      '- 测试点标题 = 检验项本身，体现来源方法：边界值拆出的写明边界位置（如"手机号长度 11 位边界"），',
      '  异常注入拆出的写明故障类型（如"断网时提交订单"），不要写"测试 xx""xx 场景"这类空泛词；',
      '- 用例标题 = 一句话讲清这个用例做什么，三要素缺一不可：[条件/前置] + 操作动作 + 预期结果。',
      '  操作动作必须写出具体步骤（点了什么、调用了什么），不能只写结果。',
      '  合格示例："输入 11 位手机号点击获取验证码，发送成功"、',
      '    "密码正确时点击登录按钮，跳转到工作台首页"。',
      '  不合格示例："正确密码登录成功"（缺操作：点了什么？）、"测试登录"、"场景 1"；',
      '  判定方法：把标题读给没参与的人听，TA 能复述出怎么操作、会看到什么，才合格；',
      '- 同一测试点下的多条用例，标题用条件区分（正常输入/空输入/超长输入…），一目了然。',
    ].join('\n'),
  );
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
