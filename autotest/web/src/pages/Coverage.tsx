import { useCallback, useEffect, useState } from 'react';
import type { Library } from 'shared';
import { api, type CasePlanPayload, type DemoScenarioPayload } from '../api';

/**
 * 覆盖矩阵（P3）：一张表回答"每个对外接口，在 demo 里有没有被用到？在真机上有没有对应控件？
 * 有没有负向用例？"
 *
 * 这一页最重要的性质是**可证伪**：每一行的状态都必须带判定理由与证据（调用点文件行号、
 * 真机控件、用例编号）。所以展开行不是"锦上添花"，而是这一页存在的意义 ——
 * 一个不带理由的红色方块，人既无法核对也无法行动。
 */
type Status = 'covered' | 'partial' | 'not_covered' | 'blocked';

interface MatrixRow {
  symbolId: number; symbolName: string; kind: string;
  status: Status; statusReason: string; riskFlags: string[];
  scenarioFit: { happy: boolean; empty: boolean; boundary: boolean; bigdata: boolean };
  deviceReachable: boolean;
  evidence: {
    demoCall?: { pagePath: string; sourceFile: string; sourceLine: number; snippet: string };
    testCallCount: number; traversalReport: string; deviceControls: string[]; devicePagePath: string;
    caseNos: string[]; negativeCaseNos: string[];
    /** P11：每条用例的来源与关联依据（矩阵图按它着色/展开） */
    caseRefs?: Array<{ caseNo: string; caseName: string; scenarioKind: string; basis: string; confidence: string }>;
    /** P11：仅弱证据关联的用例（列出，不计入覆盖率） */
    weakLinkCaseNos?: string[];
    paramPoints: Array<{ pagePath: string; name: string; sourceFile: string; sourceLine: number }>;
  };
}

interface MatrixPayload {
  libraryId: number; version: string; rows: number;
  summary: {
    total: number; covered: number; partial: number; notCovered: number; blocked: number;
    apiCoverage: number; scenarioCoverage: number; byRisk: Record<string, number>;
    /** P11：未关联到任何接口的用例数（这些用例不参与接口覆盖率） */
    unlinkedCases?: number;
    totalCases?: number;
  };
  matrix: MatrixRow[];
}

const STATUS_META: Record<Status, { label: string; color: string }> = {
  covered: { label: '已覆盖', color: 'var(--green)' },
  partial: { label: '部分覆盖', color: 'var(--amber)' },
  not_covered: { label: '未覆盖', color: 'var(--red)' },
  blocked: { label: '不可测', color: 'var(--text3)' },
};

const RISK_LABEL: Record<string, string> = {
  deprecated: '已废弃',
  name_only_signature: '签名不可信',
  type_symbol: '类型符号',
  test_only: '仅单元测试',
  no_case: '无用例',
  no_negative_case: '无负向用例',
  no_traversal_evidence: '无遍历证据',
  no_device_control: '真机无对应控件',
  no_endpoint_for_param: '无参数注入点',
  api_only: '仅 API 可调',
};

const SCENARIO_LABEL: Record<string, string> = { happy: '正向', empty: '空值', boundary: '边界异常', bigdata: '大数据' };
const SCENARIO_ORDER = ['happy', 'empty', 'boundary', 'bigdata'] as const;

/** P11：关联依据的人话说明 */
const BASIS_LABEL: Record<string, string> = {
  explicit: '生成时指定',
  page: '页面命中',
  name: '名称命中',
  manual: '人工确认',
};

export default function CoveragePage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState(0);
  const [data, setData] = useState<MatrixPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | Status>('');
  const [riskFilter, setRiskFilter] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [plan, setPlan] = useState<CasePlanPayload | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [quality, setQuality] = useState<Awaited<ReturnType<typeof api.quality>> | null>(null);
  // P11：表格 / 矩阵图两种视图（矩阵图 = 接口 × 场景 的着色网格，一眼看出哪里空着）
  const [view, setView] = useState<'table' | 'grid'>('table');
  const [cell, setCell] = useState<{ symbolId: number; scenario: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  // 场景级覆盖度（Demo 场景 × Demo 代码）：与接口级矩阵并列的第二个维度。
  // 它的分母是"场景"（P01/N07…），能看出"接口有调用点但流程没执行"这类接口维度看不见的问题。
  const [demo, setDemo] = useState<DemoScenarioPayload | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);

  const loadDemo = useCallback((id: number) => {
    if (!id) return;
    setDemoBusy(true);
    api.demoScenarios(id)
      .then((r) => setDemo(r))
      .catch(() => setDemo(null))
      .finally(() => setDemoBusy(false));
  }, []);

  useEffect(() => { loadDemo(libId); }, [libId, loadDemo]);

  /** 落库快照：md 仍是唯一事实来源，这一步只是把当前解析结果存进 DB 便于列表/趋势查询。 */
  const syncDemo = async () => {
    if (!libId) return;
    setDemoBusy(true); setError(''); setMsg('');
    try {
      const r = await api.syncDemoScenarios(libId);
      setDemo(r);
      setMsg(`已落库场景覆盖度快照：${r.rows} 条 · 整体 ${r.summary.overall}%`
        + (r.warnings.length > 0 ? ` · ⚠️ ${r.warnings.length} 条自洽告警需要处理` : ''));
    } catch (e) { setError(String((e as Error).message)); }
    finally { setDemoBusy(false); }
  };

  const exportDemo = async (format: 'md' | 'csv') => {
    if (!libId) return;
    setError(''); setMsg('');
    try {
      const r = await api.exportDemoScenarios(libId, format);
      setMsg(`已导出场景覆盖度 ${r.rows} 行到 ${r.file}`);
    } catch (e) { setError(String((e as Error).message)); }
  };

  useEffect(() => {
    api.libraries({ pageSize: 300 }).then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId(r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
  }, []);

  const load = useCallback((id: number, status = statusFilter, risk = riskFilter) => {
    if (!id) return;
    setLoading(true); setError('');
    api.coverageMatrix(id, { status: status || undefined, risk: risk || undefined })
      .then((r) => setData(r))
      .catch((e) => { setError(String((e as Error).message)); setData(null); })
      .finally(() => setLoading(false));
  }, [statusFilter, riskFilter]);

  useEffect(() => { load(libId, statusFilter, riskFilter); }, [libId, statusFilter, riskFilter, load]);

  /**
   * P11：重算「用例 ↔ 接口」关联。
   * 关联是确定性计算（不花 token），所以可以随手点；点完重建矩阵，初版遍历用例就会进「用例」列。
   */
  const relink = async () => {
    if (!libId) return;
    setLinkBusy(true); setError(''); setMsg('');
    try {
      const r = await api.rebuildCaseLinks(libId);
      const basis = Object.entries(r.byBasis).map(([k, v]) => `${BASIS_LABEL[k] ?? k} ${v}`).join(' · ') || '无';
      setMsg(`关联完成：写入 ${r.links} 条（${basis}）· 已关联 ${r.linkedCases}/${r.totalCases} 条用例`
        + (r.unlinkedCases > 0 ? ` · 仍有 ${r.unlinkedCases} 条未关联到任何接口` : '')
        + (r.preservedManual > 0 ? ` · 保留人工确认 ${r.preservedManual} 条` : ''));
      await api.buildCoverageMatrix(libId).catch(() => null);
      load(libId);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLinkBusy(false); }
  };

  const build = async () => {
    if (!libId) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.buildCoverageMatrix(libId);
      setMsg(`已构建：${r.rows} 行 · 已覆盖 ${r.summary.covered} · 部分 ${r.summary.partial} · 未覆盖 ${r.summary.notCovered} · 不可测 ${r.summary.blocked} · 接口覆盖率 ${r.summary.apiCoverage}%`);
      load(libId);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!libId) return;
    api.quality(libId).then(setQuality).catch(() => setQuality(null));
  }, [libId, msg]);

  const exportAs = async (format: 'md' | 'csv') => {    if (!libId) return;
    setError(''); setMsg('');
    try {
      const r = await api.exportCoverageMatrix(libId, format);
      setMsg(`已导出 ${r.rows} 行到 ${r.file}`);
    } catch (e) { setError(String((e as Error).message)); }
  };

  // P4 计划是 dry-run：先看"该生成哪几条、为什么、哪些符号不生成"，再决定要不要花 token
  const previewPlan = async () => {
    if (!libId) return;
    setPlanBusy(true); setError(''); setMsg('');
    try {
      const r = await api.casePlan(libId);
      setPlan(r); setShowPlans(true);
      setMsg(`用例计划：${r.summary.planned} 条（场景 ${Object.entries(r.summary.byScenario).map(([k, v]) => `${k} ${v}`).join(' · ')}）· ${r.sampling.report}`);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setPlanBusy(false); }
  };

  const s = data?.summary;
  const rows = data?.matrix ?? [];
  const risks = s ? Object.keys(s.byRisk).sort() : [];

  // ---- P11 矩阵图：接口（行）× 场景（列） ----
  // 单元格的三种状态必须能区分开，否则这张图只会制造错觉：
  //   绿色 = 该接口在这个场景下已有用例；
  //   黄色 = 该场景适用但还没有用例（这就是"该补哪里"）；
  //   灰色 = 该场景对这个接口不适用（不适用不等于没测，不能标黄吓人）。
  const gridRows = rows.filter((r) => r.kind !== 'type' && r.kind !== 'interface');
  const cellCases = (row: MatrixRow, scenario: string) =>
    (row.evidence.caseRefs ?? []).filter((c) => c.scenarioKind === scenario);
  const selectedRow = cell ? gridRows.find((r) => r.symbolId === cell.symbolId) : undefined;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>覆盖矩阵</div>
          <div className="page-desc">
            接口 × demo 调用 × 真机控件 × 用例 · 每行都带判定理由与证据
            {data?.version && <span className="muted"> · 库版本 {data.version}</span>}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ width: 240 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !libId} onClick={() => void build()}>
          {busy ? '构建中…' : '构建覆盖矩阵'}
        </button>
        <button className="btn" disabled={rows.length === 0} onClick={() => void exportAs('md')}>导出 Markdown</button>
        <button className="btn" disabled={rows.length === 0} onClick={() => void exportAs('csv')}>导出 CSV</button>
        <button className="btn" disabled={linkBusy || !libId} onClick={() => void relink()}>
          {linkBusy ? '关联中…' : '重算用例关联'}
        </button>
        <button className="btn" disabled={planBusy || !libId} onClick={() => void previewPlan()}>
          {planBusy ? '计算中…' : '生成用例计划'}
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {s && (
        <>
          <div className="grid-3" style={{ marginTop: 12 }}>
            <div className="card">
              <div className="muted" style={{ fontSize: 12 }}>接口覆盖率（有用例 / 可测符号）</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{s.apiCoverage}%</div>
              <div className="muted" style={{ fontSize: 11 }}>分母已排除「不可测」符号</div>
            </div>
            <div className="card">
              <div className="muted" style={{ fontSize: 12 }}>场景维度覆盖率</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{s.scenarioCoverage}%</div>
              <div className="muted" style={{ fontSize: 11 }}>已覆盖维度 / 适用维度</div>
            </div>
            <div className="card">
              <div className="muted" style={{ fontSize: 12 }}>用例 ↔ 接口关联</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: (s.unlinkedCases ?? 0) > 0 ? 'var(--amber)' : undefined }}>
                {s.totalCases ? `${(s.totalCases - (s.unlinkedCases ?? 0))}/${s.totalCases}` : '—'}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                {(s.unlinkedCases ?? 0) > 0
                  ? <>仍有 <b>{s.unlinkedCases}</b> 条用例没关联到任何接口，不计入覆盖率（点「重算用例关联」）</>
                  : '全部用例都已关联到接口'}
              </div>
            </div>
            <div className="card">
              <div className="muted" style={{ fontSize: 12 }}>共 {s.total} 个符号</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>
                {(Object.keys(STATUS_META) as Status[]).map((k) => (
                  <div key={k} style={{ color: STATUS_META[k].color }}>
                    {STATUS_META[k].label} {k === 'covered' ? s.covered : k === 'partial' ? s.partial : k === 'not_covered' ? s.notCovered : s.blocked}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {risks.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>风险分布（点击筛选）</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {risks.map((r) => (
                  <span
                    key={r}
                    className={`tag ${riskFilter === r ? 'blue' : 'gray'}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setRiskFilter(riskFilter === r ? '' : r)}
                  >
                    {RISK_LABEL[r] ?? r} {s.byRisk[r]}
                  </span>
                ))}
                {riskFilter && <span className="link" onClick={() => setRiskFilter('')}>清除筛选</span>}
              </div>
            </div>
          )}
        </>
      )}

      {quality && quality.total > 0 && (
        <div className="card" style={{ marginTop: 12, borderColor: quality.gates.allPassed ? 'var(--green-dim)' : 'var(--red-dim)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>质量硬门槛（P6）</b>
            <span className={`tag ${quality.gates.oracleCoverage ? 'green' : 'red'}`}>
              断言覆盖率 {quality.oracleCoverage}% {quality.gates.oracleCoverage ? '达标' : '未达 100%'}
            </span>
            <span className={`tag ${quality.gates.falsePass ? 'green' : 'red'}`}>
              假通过 {quality.falsePass} 条 {quality.gates.falsePass ? '达标' : '必须为 0'}
            </span>
            <span className="muted" style={{ fontSize: 11.5 }}>共 {quality.total} 条用例，其中 {quality.withOracle} 条有可机器校验断言</span>
          </div>
          {quality.missingOracleCases.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="muted" style={{ fontSize: 11.8, marginBottom: 3 }}>
                断言不可核验的用例（{quality.missingOracleCases.length} 条）—— 这些用例即使"通过"也判定不了任何事：
              </div>
              <div className="mono" style={{ fontSize: 11, maxHeight: 90, overflowY: 'auto', color: 'var(--text2)' }}>
                {quality.missingOracleCases.slice(0, 12).map((c) => (
                  <div key={c.caseNo}>{c.caseNo}：{c.reason}</div>
                ))}
                {quality.missingOracleCases.length > 12 && <div className="muted">… 其余 {quality.missingOracleCases.length - 12} 条</div>}
              </div>
            </div>
          )}
          {quality.falsePassCases.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11.8, marginBottom: 3, color: 'var(--red)' }}>
                ★ 假通过（{quality.falsePassCases.length} 条）：脚本通过了，但断言为空或未被校验：
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>
                {quality.falsePassCases.slice(0, 8).map((c) => <div key={c.caseNo}>{c.caseNo}：{c.reason}</div>)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 场景级覆盖度（Demo 场景 × Demo 代码）
          —— 与上面的接口级矩阵互补：分母是"场景"，所以能看见"接口有调用点、但流程其实没执行"这类
          接口维度发现不了的问题（json-schema 的 P11 规则增删就是这样被判出来的）。 */}
      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>场景覆盖度（Demo 场景 × Demo 代码）</b>
          {demo && demo.rows > 0 && (
            <span className="muted" style={{ fontSize: 11.5 }}>
              {demo.rows} 条场景 · 正向 {demo.summary.positive} / 反向 {demo.summary.negative}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn sm" disabled={demoBusy || !libId} onClick={() => loadDemo(libId)}>
            {demoBusy ? '解析中…' : '重新解析'}
          </button>
          <button className="btn sm" disabled={demoBusy || !libId || !demo || demo.rows === 0} onClick={() => void syncDemo()}>
            落库快照
          </button>
          <button className="btn sm" disabled={!demo || demo.rows === 0} onClick={() => void exportDemo('md')}>导出 MD</button>
          <button className="btn sm" disabled={!demo || demo.rows === 0} onClick={() => void exportDemo('csv')}>导出 CSV</button>
        </div>

        {(!demo || demo.rows === 0) ? (
          <div className="muted" style={{ fontSize: 12 }}>
            还没有场景覆盖度产物。先跑「demo 解析」（产出 <span className="mono">{'{库名}'}Demo场景.md</span>），
            再跑「覆盖矩阵」阶段的 ohos-demo-coverage-analyzer（产出 <span className="mono">{'{库名}'}Demo场景覆盖率报告.md</span>），
            两份文档都在 <span className="mono">workspace/coverage/{'{库名}'}/</span> 下；本卡片只解析、不臆造。
            {demo && demo.missing.length > 0 && (
              <div style={{ marginTop: 6, color: 'var(--amber)' }}>缺少：{demo.missing.join('；')}</div>
            )}
          </div>
        ) : (
          <>
            <div className="grid-3">
              <div className="card">
                <div className="muted" style={{ fontSize: 12 }}>整体覆盖率（完全 1.0 / 部分 0.5）</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>{demo.summary.overall}%</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  完全覆盖 {demo.summary.covered} · 部分 {demo.summary.partial} · 未覆盖 {demo.summary.uncovered}
                </div>
              </div>
              <div className="card">
                <div className="muted" style={{ fontSize: 12 }}>接口维度（真实执行 / 全部核对项）</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>{demo.summary.apiRate}%</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  真实执行 {demo.summary.apiExecuted} · 有条件/未生效 {demo.summary.apiConditional} · 零调用 {demo.summary.apiMissing}
                </div>
              </div>
              <div className="card">
                <div className="muted" style={{ fontSize: 12 }}>正 / 反向覆盖率</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>
                  {demo.summary.positiveRate}% <span className="muted" style={{ fontSize: 14 }}>/</span> {demo.summary.negativeRate}%
                </div>
                <div className="muted" style={{ fontSize: 11 }}>反向常是漏得最多的那一半</div>
              </div>
            </div>

            {demo.warnings.length > 0 && (
              <div className="card" style={{ marginTop: 10, borderColor: 'var(--amber)' }}>
                <div style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 4 }}>
                  ★ 自洽核对告警 {demo.warnings.length} 条（场景清单与覆盖率报告对不上，数字不可信之前先处理这些）
                </div>
                <div className="mono" style={{ fontSize: 11, maxHeight: 110, overflowY: 'auto', color: 'var(--text2)' }}>
                  {demo.warnings.slice(0, 20).map((w, i) => <div key={i}>· {w}</div>)}
                  {demo.warnings.length > 20 && <div className="muted">… 其余 {demo.warnings.length - 20} 条</div>}
                </div>
              </div>
            )}

            <div style={{ marginTop: 10, maxHeight: 420, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 54 }}>编号</th>
                    <th style={{ width: 240 }}>场景</th>
                    <th style={{ width: 56 }}>类型</th>
                    <th style={{ width: 120 }}>模块</th>
                    <th style={{ width: 84 }}>状态</th>
                    <th style={{ width: 84 }}>接口覆盖</th>
                    <th style={{ width: 220 }}>匹配文件</th>
                    <th>差距说明</th>
                  </tr>
                </thead>
                <tbody>
                  {demo.scenarios.map((r) => (
                    <tr key={r.no}>
                      <td className="mono" style={{ fontSize: 11.5 }}>{r.no}</td>
                      <td style={{ fontSize: 12 }}>{r.name}</td>
                      <td><span className={`tag ${r.kind === 'negative' ? 'gray' : 'blue'}`}>{r.kind === 'negative' ? '反向' : '正向'}</span></td>
                      <td className="muted" style={{ fontSize: 11.3 }}>{r.module || '—'}</td>
                      <td>
                        <span className={`tag ${r.status === 'covered' ? 'green' : r.status === 'partial' ? 'amber' : 'red'}`}>
                          {r.status === 'covered' ? '完全覆盖' : r.status === 'partial' ? '部分覆盖' : '未覆盖'}
                        </span>
                        {r.note && <div style={{ fontSize: 10.5, color: 'var(--amber)' }}>⚠ {r.note}</div>}
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{r.apiCovered}/{r.apiTotal}</td>
                      <td className="mono" style={{ fontSize: 10.8 }}>{r.evidence || '—'}</td>
                      <td className="muted" style={{ fontSize: 11.3 }}>{r.gap || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {demo.summary.byModule.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="muted" style={{ fontSize: 11.8, marginBottom: 4 }}>模块覆盖（每个场景归属唯一模块，不重复计数）</div>
                <table style={{ maxWidth: 720 }}>
                  <thead>
                    <tr>
                      <th>模块</th><th style={{ width: 70 }}>场景数</th><th style={{ width: 60 }}>完全</th>
                      <th style={{ width: 60 }}>部分</th><th style={{ width: 60 }}>未覆盖</th><th style={{ width: 80 }}>覆盖率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demo.summary.byModule.map((m) => (
                      <tr key={m.module}>
                        <td style={{ fontSize: 12 }}>{m.module}</td>
                        <td className="mono" style={{ fontSize: 11.5 }}>{m.total}</td>
                        <td className="mono" style={{ fontSize: 11.5, color: 'var(--green)' }}>{m.covered}</td>
                        <td className="mono" style={{ fontSize: 11.5, color: 'var(--amber)' }}>{m.partial}</td>
                        <td className="mono" style={{ fontSize: 11.5, color: 'var(--red)' }}>{m.uncovered}</td>
                        <td className="mono" style={{ fontSize: 11.5 }}>{m.rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              来源（md 是唯一事实来源，本卡片只解析）：
              <span className="mono">{demo.sources.scenarioDoc}</span>
              <span className="mono"> {demo.sources.reportDoc}</span>
            </div>
          </>
        )}
      </div>

      {plan && showPlans && (        <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent-dim)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <b>用例计划（P4 · dry-run，尚未生成）</b>
            <span className="muted" style={{ fontSize: 12 }}>
              {plan.summary.symbols} 个可测符号 → {plan.summary.planned} 条计划
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setShowPlans(false)}>收起</button>
          </div>
          <div className="muted" style={{ fontSize: 11.8, marginBottom: 10 }}>
            生成什么由覆盖矩阵与适用性规则决定，LLM 只负责把每条计划写成用例。想真正生成请到「任务管理」发起
            「矩阵驱动生成用例」任务（会消耗 LLM 调用）。
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {Object.entries(plan.summary.byScenario).map(([k, v]) => (
              <span key={k} className="tag blue">{SCENARIO_LABEL[k] ?? k} {v}</span>
            ))}
            {Object.entries(plan.summary.byPriority).map(([k, v]) => (
              <span key={k} className={`tag ${k === 'P0' ? 'green' : k === 'P1' ? 'amber' : 'gray'}`}>{k} {v}</span>
            ))}
            <span className="tag plain">{plan.sampling.report}</span>
          </div>

          {plan.summary.skippedSymbols.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                不为这些符号生成用例（{plan.summary.skippedSymbols.length} 个，覆盖矩阵判定为不可测）
              </div>
              <div className="mono" style={{ fontSize: 11.3, color: 'var(--text2)' }}>
                {plan.summary.skippedSymbols.slice(0, 12).map((s) => `${s.name}(${s.kind})`).join('、')}
                {plan.summary.skippedSymbols.length > 12 && ` … 其余 ${plan.summary.skippedSymbols.length - 12} 个`}
              </div>
            </div>
          )}

          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>优先级</th>
                  <th style={{ width: 80 }}>场景</th>
                  <th style={{ width: 220 }}>符号</th>
                  <th style={{ width: 200 }}>为什么有这条</th>
                  <th>输入设计</th>
                </tr>
              </thead>
              <tbody>
                {plan.plans.slice(0, 120).map((c, i) => (
                  <tr key={i}>
                    <td><span className={`tag ${c.priority === 'P0' ? 'green' : c.priority === 'P1' ? 'amber' : 'gray'}`}>{c.priority}</span></td>
                    <td><span className="tag gray">{SCENARIO_LABEL[c.scenario] ?? c.scenario}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {c.symbolName}
                      {c.triggerPage && <div className="muted" style={{ fontSize: 10.5 }}>{c.triggerPage}{c.triggerControl ? ` · ${c.triggerControl}` : ''}</div>}
                    </td>
                    <td className="muted" style={{ fontSize: 11.3 }}>{c.because}</td>
                    <td className="muted" style={{ fontSize: 11.3 }}>{c.inputPlan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className={`btn sm ${view === 'table' ? 'primary' : ''}`} onClick={() => setView('table')}>表格</button>
          <button className={`btn sm ${view === 'grid' ? 'primary' : ''}`} onClick={() => setView('grid')}>矩阵图</button>
          <div style={{ width: 10 }} />
          <button className={`btn sm ${statusFilter === '' ? 'primary' : ''}`} onClick={() => setStatusFilter('')}>全部</button>          {(Object.keys(STATUS_META) as Status[]).map((k) => (
            <button key={k} className={`btn sm ${statusFilter === k ? 'primary' : ''}`} onClick={() => setStatusFilter(k)}>
              {STATUS_META[k].label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 11.5 }}>
            {view === 'grid' ? '行=接口，列=场景；绿=已有用例 / 黄=适用但缺用例 / 灰=不适用。点格子看用例' : '点行展开证据'}
          </span>
        </div>

        {loading ? (
          <div className="loading">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="loading">
            {data ? '当前筛选下没有数据。' : '还没有覆盖矩阵。先在「接口清单」页采集接口，再点右上角「构建覆盖矩阵」。'}
          </div>
        ) : view === 'grid' ? (
          <div>
            {gridRows.length === 0 ? (
              <div className="loading">当前筛选下没有可测接口（类型符号不参与矩阵图）。</div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
                <table style={{ minWidth: 620 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 240 }}>接口</th>
                      <th style={{ width: 80 }}>状态</th>
                      {SCENARIO_ORDER.map((k) => (
                        <th key={k} style={{ width: 90, textAlign: 'center' }}>{SCENARIO_LABEL[k]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gridRows.map((r) => (
                      <tr key={r.symbolId}>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {r.symbolName}
                          <div className="muted" style={{ fontSize: 10.5 }}>{r.kind}</div>
                        </td>
                        <td><span className="tag" style={{ color: STATUS_META[r.status].color }}>{STATUS_META[r.status].label}</span></td>
                        {SCENARIO_ORDER.map((k) => {
                          const list = cellCases(r, k);
                          const fit = Boolean(r.scenarioFit[k]);
                          const active = cell?.symbolId === r.symbolId && cell?.scenario === k;
                          // 不适用 → 灰；适用且有用例 → 绿；适用但没用例 → 黄（要补的就是这些）
                          const color = !fit ? 'var(--text3)' : list.length > 0 ? 'var(--green)' : 'var(--amber)';
                          const bg = !fit ? 'transparent' : list.length > 0 ? 'var(--green-dim)' : 'var(--amber-dim)';
                          return (
                            <td
                              key={k}
                              style={{ textAlign: 'center', cursor: 'pointer', background: bg, outline: active ? '1px solid var(--blue)' : 'none' }}
                              title={fit ? (list.length > 0 ? list.map((c) => `${c.caseNo} ${c.caseName}`).join('\n') : '该场景适用但还没有用例') : '该场景对这个接口不适用'}
                              onClick={() => setCell(active ? null : { symbolId: r.symbolId, scenario: k })}
                            >
                              <span style={{ color, fontWeight: 600 }}>{fit ? (list.length > 0 ? list.length : '缺') : '—'}</span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {selectedRow && cell && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <b className="mono">{selectedRow.symbolName}</b>
                  <span className="muted"> · {SCENARIO_LABEL[cell.scenario] ?? cell.scenario}场景 ·
                    {cellCases(selectedRow, cell.scenario).length} 条用例</span>
                </div>
                {cellCases(selectedRow, cell.scenario).length === 0 ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    该场景适用但还没有用例。可在「任务管理」发起「矩阵驱动生成用例」，或用「整合初版用例为正式用例」把初版草稿升级并挂到本接口。
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr><th style={{ width: 110 }}>用例号</th><th style={{ width: 260 }}>名称</th><th style={{ width: 120 }}>关联依据</th><th>置信度</th></tr>
                    </thead>
                    <tbody>
                      {cellCases(selectedRow, cell.scenario).map((c) => (
                        <tr key={c.caseNo}>
                          <td className="mono" style={{ fontSize: 11.5 }}>{c.caseNo}</td>
                          <td style={{ fontSize: 12 }}>{c.caseName}</td>
                          <td><span className="tag gray">{BASIS_LABEL[c.basis] ?? c.basis ?? '—'}</span></td>
                          <td className="muted" style={{ fontSize: 11.5 }}>{c.confidence === 'low' ? '弱（不参与判定）' : c.confidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(selectedRow.evidence.weakLinkCaseNos?.length ?? 0) > 0 && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    另有弱关联用例（仅名称命中，不参与覆盖率判定）：{selectedRow.evidence.weakLinkCaseNos!.join('、')}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 210 }}>符号</th>
                <th style={{ width: 70 }}>类型</th>
                <th style={{ width: 90 }}>状态</th>
                <th>判定理由</th>
                <th style={{ width: 200 }}>风险</th>
                <th style={{ width: 130 }}>适用场景</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RowView key={r.symbolId} row={r} expanded={expanded === r.symbolId} onToggle={() => setExpanded(expanded === r.symbolId ? null : r.symbolId)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function RowView({ row, expanded, onToggle }: { row: MatrixRow; expanded: boolean; onToggle: () => void }) {
  const meta = STATUS_META[row.status];
  const fit = Object.entries(row.scenarioFit).filter(([, v]) => v).map(([k]) => SCENARIO_LABEL[k] ?? k);
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td className="mono">{row.symbolName}</td>
        <td><span className="tag gray">{row.kind}</span></td>
        <td><span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span></td>
        <td style={{ fontSize: 11.8 }}>{row.statusReason}</td>
        <td>
          {row.riskFlags.length === 0 ? <span className="muted">—</span> : row.riskFlags.map((f) => (
            <span key={f} className={`tag ${f === 'no_case' || f === 'deprecated' ? 'red' : f === 'test_only' || f === 'no_negative_case' ? 'amber' : 'gray'}`} style={{ marginRight: 4, marginBottom: 2 }}>
              {RISK_LABEL[f] ?? f}
            </span>
          ))}
        </td>
        <td className="muted" style={{ fontSize: 11.5 }}>{fit.join(' / ') || '—'}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--panel3)' }}>
            <div style={{ padding: '8px 2px', fontSize: 12, lineHeight: 1.9 }}>
              <div>
                <b>demo 调用点</b>：
                {row.evidence.demoCall
                  ? <span className="mono">{row.evidence.demoCall.sourceFile}:{row.evidence.demoCall.sourceLine}（页面 {row.evidence.demoCall.pagePath || '—'}）</span>
                  : <span className="muted">无（src/main 里没有调用）</span>}
              </div>
              <div><b>单元测试调用</b>：{row.evidence.testCallCount > 0 ? `${row.evidence.testCallCount} 处` : <span className="muted">无</span>}</div>
              <div>
                <b>真机证据</b>：
                {row.evidence.deviceControls.length > 0
                  ? <span>页面 <span className="mono">{row.evidence.devicePagePath}</span> · 控件 {row.evidence.deviceControls.slice(0, 6).join('、')}</span>
                  : <span className="muted">{row.evidence.traversalReport ? '遍历报告里没有找到对应页面（可能未遍历到）' : '没有遍历报告可对照，先在真机跑一次遍历'}</span>}
              </div>
              <div>
                <b>用例</b>：{row.evidence.caseNos.length > 0
                  ? <span>{row.evidence.caseNos.join('、')}{row.evidence.negativeCaseNos.length > 0 ? `（负向：${row.evidence.negativeCaseNos.join('、')}）` : '（全为正向）'}</span>
                  : <span className="muted">没有针对该接口的用例</span>}
              </div>
              {(row.evidence.caseRefs?.length ?? 0) > 0 && (
                <div>
                  <b>用例来源与关联依据</b>（初版遍历用例也会出现在这里）：
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {row.evidence.caseRefs!.map((c) => (
                      <div key={c.caseNo}>
                        <span className="mono">{c.caseNo}</span> {c.caseName} ·
                        <span className="tag gray" style={{ marginLeft: 4 }}>{BASIS_LABEL[c.basis] ?? c.basis ?? '—'}</span>
                        <span className="muted"> {c.confidence === 'low' ? '弱关联（不计入覆盖率）' : c.confidence}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(row.evidence.weakLinkCaseNos?.length ?? 0) > 0 && (
                <div className="muted" style={{ fontSize: 11.5 }}>
                  弱关联用例（仅名称命中，不参与覆盖率判定）：{row.evidence.weakLinkCaseNos!.join('、')}
                </div>
              )}
              {row.evidence.paramPoints.length > 0 && (
                <div>
                  <b>可注入参数点</b>：
                  <span className="mono">{row.evidence.paramPoints.slice(0, 4).map((p) => `${p.name}@${p.sourceFile}:${p.sourceLine}`).join(' , ')}</span>
                </div>
              )}
              <div className="muted" style={{ fontSize: 11 }}>
                判定依据：状态由「demo 正向调用 + 至少一条负向用例」共同决定；只有正向调用判为部分覆盖，不会记为已覆盖。
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
