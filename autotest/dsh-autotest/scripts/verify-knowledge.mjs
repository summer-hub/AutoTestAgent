// P9（LLM wiki 知识库）+ P10（Agent 绑定）的自检（无设备、无 LLM；用临时 knowledge 目录）。
//
// P9 的重点是"无向量检索到底靠不靠得住"：作用域精确命中优先、关键词命中排序、预算截断、
// 必注入规则（至少 1 条库级 + 1 条场景级）、已否决的条目不参与，以及**注入格式**。
// P10 的重点是"换了 agent 真的生效且可追溯"：绑定优先级（按库 > 全局 > 内置）、
// 非法绑定被拒、阶段清单与输入输出约定完整、MCP 工具清单可被外部 agent 消费。
//
// 用法：npm run build && npm run verify:knowledge
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-p9-'));
// 自检必须在临时工作区里跑：绝不能碰使用者真实工作区里的仓库与知识库。
// （与 AUTOTEST_DATA_DIR 同一套约定，见 gitRepo.workspaceDir 的说明。）
process.env.AUTOTEST_WORKSPACE = tmp;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

const K = await import('../lib/services/knowledge.js');
const A = await import('../lib/services/agentBinding.js');

const entry = (over = {}) => ({
  id: over.id ?? 'kn-test', scopeKind: 'library', scopeKey: 'demo-lib', kind: 'traversal_quirk',
  title: over.title ?? '标题', keywords: over.keywords ?? [], status: over.status ?? 'ai_draft',
  confidence: over.confidence ?? 50, evidence: over.evidence ?? [{ task: 1 }],
  body: over.body ?? '## 现象\n现象\n## 处置\n处置\n## 结论\n结论',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', wikiPath: `${over.id ?? 'kn-test'}.md`,
  ...over,
});

// ---------- 1. front-matter 往返 ----------
console.log('— front-matter 读写（md 是唯一事实来源）—');
{
  const md = K.renderEntry(entry({ keywords: ['lottie', '循环'], evidence: [{ task: 128 }, { explore: 'explore_1.json' }], confidence: 90 }));
  check(md.startsWith('---\n'), 'md 以 front-matter 开头');
  check(md.includes('scope_kind: library') && md.includes('scope_key: demo-lib'), 'front-matter 含作用域键');
  check(md.includes('keywords: lottie 循环'), 'keywords 空格分隔');
  check(md.includes('  - {"task":128}'), 'evidence 逐条序列化');
  check(md.includes('## 现象') && md.includes('## 处置') && md.includes('## 结论'), '正文四段结构保留');

  const back = K.parseEntry(md);
  eq(back?.title, '标题', '解析回标题');
  eq(back?.keywords, ['lottie', '循环'], '解析回 keywords');
  eq(back?.confidence, 90, '解析回 confidence');
  eq(back?.evidence.length, 2, '解析回 evidence');
  check(md === K.renderEntry({ ...entry({ keywords: ['lottie', '循环'], evidence: [{ task: 128 }, { explore: 'explore_1.json' }], confidence: 90 }), body: back.body }), '渲染→解析→渲染 稳定（往返一致）');

  eq(K.parseEntry('没有 front-matter 的文本'), null, '★ 缺 front-matter 返回 null（不抛错，坏文件不该拖垮整库）');
  check(K.parseEntry('---\nid: x\n---\n正文') === null, '缺 title 也返回 null');
  const weird = K.parseEntry('---\nid: x\ntitle: T\nscope_kind: 未知\nkind: 未知\nstatus: 未知\n---\n正文');
  eq([weird?.scopeKind, weird?.kind, weird?.status], ['global', 'human_verdict', 'ai_draft'], '★ 非法枚举值回落到安全默认（不产生非法状态）');
  eq(K.parseEntry('---\nid: x\ntitle: T\nconfidence: 999\n---\n')?.confidence, 100, 'confidence 越界被夹到 0-100');
  check(K.slugify('「无限循环」开关打开后/遍历会卡住') .length > 0, 'slug 生成可读文件名');
  check(!/[\\/:*?"<>|]/.test(K.slugify('a/b\\c:d*e?f"g<h>i|j')), '★ slug 去掉文件名非法字符');
}

// ---------- 2. 检索（三级、无向量） ----------
console.log('\n— 检索（作用域精确 > 关键词 > 预算截断）—');
{
  const entries = [
    entry({ id: 'api-1', scopeKind: 'api', scopeKey: 'demo-lib:Validator', kind: 'oracle_recipe', title: 'Validator 的判据', keywords: ['validator', 'schema'] }),
    entry({ id: 'lib-1', scopeKind: 'library', scopeKey: 'demo-lib', kind: 'traversal_quirk', title: '该库遍历会卡在动画页', keywords: ['动画', '卡住'] }),
    entry({ id: 'lib-other', scopeKind: 'library', scopeKey: '另一个库', kind: 'traversal_quirk', title: '别的库的经验', keywords: ['动画'] }),
    entry({ id: 'sc-1', scopeKind: 'scenario', scopeKey: 'bigdata', kind: 'special_handling', title: '大数据的通用处置', keywords: ['bigdata'] }),
    entry({ id: 'gl-1', scopeKind: 'global', scopeKey: '', kind: 'human_verdict', title: '通用结论', keywords: ['demo'] }),
    entry({ id: 'rej-1', scopeKind: 'library', scopeKey: 'demo-lib', kind: 'human_verdict', title: '已被否决的结论', keywords: ['动画'], status: 'rejected' }),
  ];
  const r = K.retrieve({ library: 'demo-lib', apiName: 'demo-lib:Validator', scenarioKind: 'bigdata' }, entries, 10000);
  const ids = r.selected.map((e) => e.id);
  check(ids.includes('api-1'), '★ 接口级精确命中被召回');
  check(ids.includes('lib-1'), '★ 本库作用域命中被召回');
  check(ids.includes('sc-1'), '★ 场景级命中被召回');
  check(!ids.includes('rej-1'), '★ 已否决的条目不参与检索');
  const whyApi = r.scored.find((s) => s.entry.id === 'api-1')?.why ?? '';
  check(whyApi.includes('作用域精确命中'), '★ 召回理由可逐字解释（不是黑盒相似度）', whyApi);
  check(r.scored.find((s) => s.entry.id === 'api-1').score > (r.scored.find((s) => s.entry.id === 'lib-other')?.score ?? 0),
    '精确命中得分高于仅关键词命中');

  // 人工确认的条目前置
  const confirmed = K.retrieve({ library: 'demo-lib' }, [
    entry({ id: 'draft', scopeKind: 'library', scopeKey: 'demo-lib', confidence: 90, status: 'ai_draft' }),
    entry({ id: 'ok', scopeKind: 'library', scopeKey: 'demo-lib', confidence: 50, status: 'human_confirmed' }),
  ], 10000);
  check(confirmed.scored[0].entry.id === 'ok', '★ 同等条件下人工已确认的排在前面', confirmed.scored.map((s) => `${s.entry.id}:${s.score}`).join(' '));

  // 必注入：至少 1 条 library + 1 条 scenario
  const tiny = K.retrieve({ library: 'demo-lib', scenarioKind: 'bigdata' }, entries, 10);
  const tinyIds = tiny.selected.map((e) => e.id);
  check(tinyIds.some((i) => i.startsWith('lib-') || i === 'lib-1'), '★ 预算极小也保证注入 1 条库级条目', JSON.stringify(tinyIds));
  check(tiny.truncated > 0, '被截断的条数被报出（不静默丢弃）', `truncated=${tiny.truncated}`);

  check(K.retrieve({ library: '不存在的库' }, entries, 10000).selected.length === 0, '没有任何命中时返回空（不硬塞）');
  check(K.retrieve({ library: 'demo-lib' }, [], 10000).selected.length === 0, '空知识库不报错');

  // 注入格式
  const inj = K.renderInjection(r.selected);
  check(inj.includes('【历史经验'), '注入文本有明确标题（标明是项目经验不是通用常识）');
  check(inj.includes('来源：') && inj.includes('置信度'), '注入条目标注来源与置信度');
  check(!inj.includes('scope_kind'), '注入不含 front-matter（省预算）');
  check(K.renderInjection([]) === '', '没有命中时注入为空串（不产生噪音）');
  // tokenize
  check(K.tokenize('getSchemaValue').includes('getschemavalue') || K.tokenize('getSchema').includes('schema'), 'tokenize 切出可匹配词', JSON.stringify(K.tokenize('getSchema')));
  check(!K.tokenize('a b').includes('a'), 'tokenize 过滤单字噪声');
}

// ---------- 3. 生命周期 ----------
console.log('\n— 生命周期（ai_draft → human_confirmed）—');
{
  check(!K.canConfirm(entry({ evidence: [] })).ok, '★ 没有证据不允许标为人工确认（知识库不能收传闻）');
  check(K.canConfirm(entry({ evidence: [] })).reason.includes('证据'), '拒绝理由指明缺证据');
  check(!K.canConfirm(entry({ evidence: [{}] })).ok, '★ 空 evidence 对象同样不算证据');
  check(K.canConfirm(entry({ evidence: [{ task: 1 }] })).ok, '有真实证据可以确认');
  check(K.canConfirm(entry({ status: 'human_confirmed' })).ok, '已确认的条目重复确认不报错');

  const kinds = ['demo_patch', 'oracle_missing', 'external_dep', 'animation', 'flaky', 'long_running', 'device_blocked', 'untestable'];
  const mapped = kinds.map((k) => K.kindForStage(k));
  check(mapped.every((m) => ['demo_patch', 'oracle_recipe', 'blocked_reason', 'traversal_quirk', 'special_handling', 'human_verdict'].includes(m)),
    '队列 stage → 知识 kind 映射值合法', JSON.stringify(mapped));
  eq(K.kindForStage('oracle_missing'), 'oracle_recipe', 'oracle 缺失 → 判据配方');
  eq(K.kindForStage('demo_patch'), 'demo_patch', '补丁问题 → demo 补丁类知识');
  eq(K.kindForStage('flaky'), 'traversal_quirk', 'flaky → 遍历怪癖');
  eq(Object.keys(K.SCOPE_LABEL).length, 5, '5 种作用域都有中文标签');
}

// ---------- 4. Agent 绑定 ----------
console.log('\n— Agent 绑定（阶段即接口）—');
{
  eq(A.STAGES.length, 9, '阶段清单 9 个（设计 §8.1）');
  check(A.STAGES.every((s) => s.stage && s.label && s.builtinRole && s.input && s.output),
    '★ 每个阶段都有输入输出约定（外部 agent 按同一份约定接）');
  check(A.STAGES.every((s) => A.stageDef(s.stage)?.stage === s.stage), 'stageDef 能查到每个阶段');
  eq(A.stageDef('case_draft')?.output, 'DraftCase[]（含 scenario_kind、oracle、priority）', '用例生成阶段的输出约定写明了 oracle 与 priority');
  eq(Object.keys(A.AGENT_KIND_LABEL).length, 4, '4 种 agent 实现方式（内置/Prompt/Skill/外部）');

  // 绑定校验（不给非法绑定留口子）
  const bad = [
    [{ stage: '不存在的阶段', scope: 'global', kind: 'prompt', promptId: 1 }, '未知阶段'],
    [{ stage: 'case_draft', scope: 'library', kind: 'prompt', promptId: 1 }, '按库绑定必须指定 libraryId'],
    [{ stage: 'case_draft', scope: 'global', kind: 'skill' }, '绑定 Skill 必须给出 skillPath'],
    [{ stage: 'case_draft', scope: 'global', kind: 'prompt' }, '绑定自写 Prompt 必须给出 promptId'],
    [{ stage: 'case_draft', scope: 'global', kind: 'external' }, '绑定外部 Agent 必须给出 externalCmd'],
  ];
  for (const [b, expect] of bad) {
    let msg = '';
    try { await A.upsertBinding(b); } catch (e) { msg = String(e.message); }
    check(msg.includes(expect), `★ 非法绑定被拒：${expect}`, msg.slice(0, 60));
  }

  // 可追溯
  const line = A.bindingTraceLine({
    stage: 'case_draft', kind: 'prompt', source: '按库绑定（库 #2）', scope: 'library', libraryId: 2,
    promptId: 7, skillPath: '', model: 'x', params: { temperature: 0.2 }, externalCmd: '',
  });
  check(line.includes('阶段 case_draft') && line.includes('prompt #7') && line.includes('model x'), '★ 轨迹行含阶段、来源、实现方式、模型、参数（可追溯）', line);

  // 外部 agent 可用性探测
  check(A.externalCmdAvailable('绝对不存在的命令xyz') === undefined || !A.externalCmdAvailable('绝对不存在的命令xyz').available,
    '不存在的命令判为不可用');
  check(!A.externalCmdAvailable('').available, '空命令判为不可用');
  const nodeOk = A.externalCmdAvailable(process.platform === 'win32' ? 'node.exe' : 'node');
  check(nodeOk.available, 'PATH 中存在的命令判为可用', nodeOk.reason);
}

// ---------- 5. MCP 工具清单与 JSON-RPC ----------
console.log('\n— MCP 互操作（外部 agent 接入点）—');
{
  const tools = A.mcpTools();
  check(tools.length >= 6, '暴露的工具 ≥6 个（矩阵查询/用例读写/知识检索/队列/质量）', `n=${tools.length}`);
  check(tools.every((t) => t.name.startsWith('autotest.')), '工具名统一前缀（外部 agent 好识别）');
  check(tools.every((t) => t.description.length > 8), '每个工具都有可读描述');
  check(tools.every((t) => t.inputSchema.type === 'object'), '★ 每个工具都有 object 型 inputSchema（MCP 要求）');
  check(tools.some((t) => t.name === 'autotest.case_write' && t.inputSchema.required.includes('oracles')),
    '★ case_write 强制要求 oracles（写入路径也守住 P6 硬门槛）');
  check(tools.some((t) => t.name === 'autotest.coverage_matrix'), '暴露覆盖矩阵查询');
  check(tools.some((t) => t.name === 'autotest.knowledge_retrieve'), '暴露知识检索');

  const init = A.mcpInitializeResult();
  check(init.protocolVersion && init.capabilities && init.serverInfo, 'initialize 返回协议版本/能力/服务信息');
  const ok = A.rpcResult(1, { tools });
  eq([ok.jsonrpc, ok.id, ok.error], ['2.0', 1, undefined], '成功响应形状符合 JSON-RPC 2.0');
  const err = A.rpcError(2, A.JSONRPC.METHOD_NOT_FOUND, '未知方法');
  eq([err.jsonrpc, err.error.code], ['2.0', -32601], '错误响应带标准 JSON-RPC 错误码');
  eq(A.rpcError(null, A.JSONRPC.PARSE_ERROR, 'x').id, null, '解析错误时 id 为 null（协议要求）');
  eq(Object.keys(A.JSONRPC).length, 5, '5 个标准错误码');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
