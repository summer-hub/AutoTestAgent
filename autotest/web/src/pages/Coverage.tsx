import { useCallback, useEffect, useState } from 'react';
import type { Library } from 'shared';
import { api, type CasePlanPayload } from '../api';

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
    paramPoints: Array<{ pagePath: string; name: string; sourceFile: string; sourceLine: number }>;
  };
}

interface MatrixPayload {
  libraryId: number; version: string; rows: number;
  summary: {
    total: number; covered: number; partial: number; notCovered: number; blocked: number;
    apiCoverage: number; scenarioCoverage: number; byRisk: Record<string, number>;
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

  const exportAs = async (format: 'md' | 'csv') => {
    if (!libId) return;
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

      {plan && showPlans && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent-dim)' }}>
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
          <button className={`btn sm ${statusFilter === '' ? 'primary' : ''}`} onClick={() => setStatusFilter('')}>全部</button>          {(Object.keys(STATUS_META) as Status[]).map((k) => (
            <button key={k} className={`btn sm ${statusFilter === k ? 'primary' : ''}`} onClick={() => setStatusFilter(k)}>
              {STATUS_META[k].label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 11.5 }}>点行展开证据</span>
        </div>

        {loading ? (
          <div className="loading">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="loading">
            {data ? '当前筛选下没有数据。' : '还没有覆盖矩阵。先在「接口清单」页采集接口，再点右上角「构建覆盖矩阵」。'}
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
