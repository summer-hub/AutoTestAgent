import { useCallback, useEffect, useState } from 'react';
import type { AnalysisReport, IssueAttribution } from 'shared';
import type { IssueTicket } from '../api';
import { api } from '../api';

/**
 * 问题归因页（R5）：人对用例有疑问 → 填问题现象 → AI 定位根因 → 自测试 → 人工验收。
 *
 * 这是平台"链尾"之外新增的一条闭环：以前只能对失败执行做事后归因，
 * 现在人对**任何**用例有疑问都能发起一次完整调查，且结论经人工验收后沉淀进知识库。
 *
 * 设计要点：
 *   · 工单是一次性档案（symptom 快照 + AI 根因 + 证据 + 自测试 + 人工结论），
 *     不是 cases.symptom 的编辑界面——两者分工在 schema 注释里写明了；
 *   · 验收必须填理由（空理由 = 没处理），接受才沉淀知识、驳回也留理由供反查；
 *   · 无真机时自测试会失败，此时页面要明说"未验证"而不是让人误以为已验证。
 *   · B3：归因（attribution）是主结论，人工可修正且必须留理由；
 *     分析完成后自动生成 Markdown 报告，可下载、可重新生成（新报告，历史保留）。
 */
const STATUS_TAG: Record<string, string> = {
  pending: 'gray', analyzing: 'blue', root_caused: 'blue',
  verifying: 'amber', accepted: 'green', rejected: 'red', failed: 'red',
};
const STATUS_LABEL: Record<string, string> = {
  pending: '待分析', analyzing: '分析中', root_caused: '已出根因',
  verifying: '自测试中', accepted: '已验收通过', rejected: '已驳回', failed: '验证失败',
};

/** B3：归因枚举与显示标签（设计 §9.3；与后端 ATTRIBUTIONS 一一对应）。 */
const ATTRIBUTION_OPTIONS: Array<{ value: IssueAttribution; label: string }> = [
  { value: 'case_precondition', label: '用例预置条件' },
  { value: 'demo', label: 'Demo 工程' },
  { value: 'library', label: '库本身' },
  { value: 'environment', label: '环境（设备/工具链）' },
  { value: 'flaky', label: '不稳定（flaky）' },
  { value: 'unknown', label: '不确定' },
];
const ATTRIBUTION_LABEL: Record<string, string> = Object.fromEntries(ATTRIBUTION_OPTIONS.map((o) => [o.value, o.label]));
const ATTRIBUTION_TAG: Record<string, string> = {
  case_precondition: 'amber', demo: 'cyan', library: 'red', environment: 'purple', flaky: 'blue', unknown: 'gray',
};

/**
 * 历史「规则降级」工单（analysisBy === 'rule'）——改造前的遗留数据。
 *
 * 那时 LLM 不可用会把上下文里的线索罗列一遍当作根因落库，实际没有任何推断。
 * 现在降级入口已删除，新工单不可能再产生这个值，但库里可能还有老行。
 * 它和一个真正的 LLM 结论长得完全一样（同样的卡片、同样的证据列表），
 * 所以必须醒目标成"不可信"并引导重新分析，否则人会照着这份假结论去改代码。
 */
const isLegacyRuleCause = (t: IssueTicket): boolean => t.rootCause?.analysisBy === 'rule';

export default function IssuePage({ fixedLibraryId }: { fixedLibraryId?: number } = {}) {
  const [tickets, setTickets] = useState<IssueTicket[] | null>(null);
  const [selected, setSelected] = useState<IssueTicket | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'accepted'>('all');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [verdictText, setVerdictText] = useState('');
  // B3：归因修正 + 报告
  const [attrPick, setAttrPick] = useState<IssueAttribution>('unknown');
  const [attrReason, setAttrReason] = useState('');
  const [reports, setReports] = useState<AnalysisReport[] | null>(null);
  const [reportInfo, setReportInfo] = useState<AnalysisReport | null>(null);

  const load = useCallback(() => {
    setError('');
    const status = filter === 'open' ? undefined : filter === 'accepted' ? 'accepted' : undefined;
    api.issues({ libraryId: fixedLibraryId ?? undefined, status, limit: 100 })
      .then((r) => setTickets(r.items))
      .catch((e) => setError(String((e as Error).message)));
    api.reports({ limit: 50 })
      .then((r) => setReports(r.items))
      .catch(() => setReports([]));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const open = async (id: number) => {
    setVerdictText('');
    try {
      const t = await api.issue(id);
      setSelected(t);
      setAttrPick(t.attribution ?? 'unknown');
      setAttrReason('');
      // 报告元数据（无报告 404 属正常，静默置空）
      api.issueReport(id).then(setReportInfo).catch(() => setReportInfo(null));
    } catch (e) { setError(String((e as Error).message)); }
  };

  const analyze = async (id: number) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.issueAnalyze(id);
      setMsg(`已发起分析（任务 #${r.taskId}）。在「任务管理」页查看进度；自测试需要在线真机，无设备时会失败并写明原因。`);
      await open(id);
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const accept = async (id: number) => {
    const reason = verdictText.trim();
    if (!reason) { setError('请先填写验收结论（空结论等于没处理；该结论会沉淀为知识条目）'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.issueAccept(id, reason);
      setMsg(`已验收通过${r.knowledgeId ? `，结论已沉淀为知识条目 ${r.knowledgeId}` : ''}`);
      setSelected(r); setVerdictText('');
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const reject = async (id: number) => {
    const reason = verdictText.trim();
    if (!reason) { setError('请先填写驳回理由（供反查"为什么这条结论不成立"）'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.issueReject(id, reason);
      setMsg('已驳回（理由已留存）');
      setSelected(r); setVerdictText('');
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  // B3：人工修正归因（必须留理由 —— 修正历史回查"为什么改了结论"）
  const fixAttribution = async (id: number) => {
    const reason = attrReason.trim();
    if (!reason) { setError('修正归因必须填理由（供反查"为什么改了归因"）'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.issueUpdateAttribution(id, attrPick, reason);
      setMsg(`归因已修正为「${ATTRIBUTION_LABEL[attrPick] ?? attrPick}」（理由已留痕）`);
      setSelected(r); setAttrReason('');
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  // B3：生成/重新生成报告（不可变 —— 每次新报告，历史保留）
  const generateReport = async (id: number) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.issueReportGenerate(id);
      setReportInfo(r);
      setMsg(`报告已生成：${r.reportNo}（重新生成会产生新报告，旧报告保留可查）`);
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  // B3：下载报告 Markdown
  const downloadReport = async (id: number, filename: string) => {
    try {
      const blob = await api.issueReportDownload(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(`报告下载失败：${(e as Error).message}`); }
  };

  const items = tickets ?? [];
  const openCount = items.filter((t) => !['accepted', 'rejected'].includes(t.status)).length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>问题归因</div>
          <div className="page-desc">
            对用例的疑问 → AI 克隆工程定位根因 → 自测试 → 人工验收
            {tickets && <span className="muted"> · 共 {items.length} 单 · 待处理 {openCount}</span>}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {([['all', '全部'], ['open', '待处理'], ['accepted', '已通过']] as const).map(([k, label]) => (
          <button key={k} className={`btn sm ${filter === k ? 'primary' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <button className="btn sm" onClick={load}>刷新</button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'flex-start' }}>
        {/* 左：工单列表 */}
        <div style={{ width: 340, flexShrink: 0 }}>
          {items.length === 0 && <div className="card muted">还没有问题工单。到「测试用例」页对某条用例填写「问题现象」即可发起。</div>}
          {items.map((t) => (
            <div
              key={t.id}
              className="card"
              style={{
                marginBottom: 8, cursor: 'pointer',
                borderColor: selected?.id === t.id ? 'var(--accent-dim)' : undefined,
              }}
              onClick={() => void open(t.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <b className="mono" style={{ fontSize: 12 }}>{t.ticketNo}</b>
                <span className={`tag ${STATUS_TAG[t.status] ?? 'gray'}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
                <div style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: 10.5 }}>用例 #{t.caseId}</span>
              </div>
              <div style={{ fontSize: 12, marginTop: 4 }}>{t.symptom.slice(0, 80)}{t.symptom.length > 80 ? '…' : ''}</div>
              {t.rootCause && (
                isLegacyRuleCause(t) ? (
                  // 遗留降级产物：不能和一个正常 LLM 结论共用同一套中性文案
                  <div style={{ fontSize: 10.5, marginTop: 3, color: 'var(--red, #e5534b)' }}
                    title="改造前的降级产物：只罗列了线索，没有做根因推断，请重新分析">
                    ⚠️ 历史降级结论 · 非根因 · 建议重新分析
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                    置信度 {t.rootCause.confidence} · 证据 {t.rootCause.evidence.length} 条 · LLM
                  </div>
                )
              )}
            </div>
          ))}
        </div>

        {/* 右：工单详情 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selected && <div className="card muted">选择左侧工单查看详情。</div>}
          {selected && (
            <>
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <b className="mono">{selected.ticketNo}</b>
                  <span className={`tag ${STATUS_TAG[selected.status] ?? 'gray'}`}>{STATUS_LABEL[selected.status] ?? selected.status}</span>
                  {/* B3 归因标签：主结论（人工修正后覆盖 LLM 结论） */}
                  <span className={`tag ${ATTRIBUTION_TAG[selected.attribution] ?? 'gray'}`} title={selected.attributionReason || undefined}>
                    归因：{ATTRIBUTION_LABEL[selected.attribution] ?? selected.attribution}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>用例 #{selected.caseId} · 创建于 {selected.createdAt}</span>
                  <div style={{ flex: 1 }} />
                  {/* B3 报告动作：有报告 → 下载/重生成；无报告但有根因 → 生成 */}
                  {reportInfo && (
                    <>
                      <button className="btn sm" disabled={busy} onClick={() => void downloadReport(selected.id, `${reportInfo.reportNo}.md`)}>
                        ⬇ 下载报告 {reportInfo.reportNo}
                      </button>
                      <button className="btn sm" disabled={busy} onClick={() => void generateReport(selected.id)}>重新生成报告</button>
                    </>
                  )}
                  {!reportInfo && selected.rootCause && (
                    <button className="btn sm" disabled={busy} onClick={() => void generateReport(selected.id)}>📄 生成报告</button>
                  )}
                  {/* 历史降级工单也要能重跑：后端 /analyze 无状态守卫，root_caused 可直接重新分析 */}
                  {(selected.status === 'pending' || selected.status === 'failed' || isLegacyRuleCause(selected)) && (
                    <button className="btn sm primary" disabled={busy} onClick={() => void analyze(selected.id)}>
                      {busy ? '发起中…' : isLegacyRuleCause(selected) ? '重新分析' : '发起 AI 分析'}
                    </button>
                  )}
                </div>

                {/* B3 追溯 chips：从执行发起时自动带链路；历史数据显示"未知"不伪造 */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {selected.executionId ? (
                    <span className="tag blue" title="从执行发起（设计 §9.1）：工单自动带执行/运行/基线/用例版本链路">执行 #{selected.executionId}</span>
                  ) : (
                    <span className="tag gray" title="从用例发起：报告会标注「未绑定具体执行」">未绑定具体执行</span>
                  )}
                  {selected.baselineId
                    ? <span className="tag blue">基线 #{selected.baselineId}</span>
                    : <span className="tag gray">基线：未知（历史数据）</span>}
                  {selected.caseVersion
                    ? <span className="tag purple">用例 V{selected.caseVersion}</span>
                    : <span className="tag gray">用例版本：未知（历史数据）</span>}
                  {selected.testRunId && <span className="tag plain">运行 #{selected.testRunId}</span>}
                </div>

                <div style={{ marginTop: 10 }}>
                  <div className="muted" style={{ fontSize: 11.5 }}>问题现象（人填写，提交后快照不改）</div>
                  <div style={{ fontSize: 13, marginTop: 2 }}>{selected.symptom}</div>
                </div>

                {selected.error && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red, #e5534b)' }}>⚠️ {selected.error}</div>
                )}

                {selected.verdict && (
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    <span className={`tag ${selected.verdict === 'accepted' ? 'green' : 'red'}`}>
                      {selected.verdict === 'accepted' ? '人工验收通过' : '人工驳回'}
                    </span>
                    <span className="muted"> {selected.verdictBy} · {selected.verdictAt}</span>
                    <div style={{ marginTop: 3 }}>{selected.verdictReason}</div>
                    {selected.knowledgeId && (
                      <div className="muted" style={{ fontSize: 11 }}>已沉淀知识条目：<span className="mono">{selected.knowledgeId}</span>（知识库页可查）</div>
                    )}
                  </div>
                )}
              </div>

              {/* 根因卡片 */}
              {selected.rootCause && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <b>根因结论</b>
                    <span className={isLegacyRuleCause(selected) ? 'tag red' : 'tag gray'}>
                      {isLegacyRuleCause(selected) ? '⚠️ 历史降级 · 非根因' : 'LLM 分析'}
                    </span>
                    {!isLegacyRuleCause(selected) && (
                      <span className={`tag ${selected.rootCause.confidence >= 70 ? 'green' : selected.rootCause.confidence >= 40 ? 'amber' : 'red'}`}>
                        置信度 {selected.rootCause.confidence}
                      </span>
                    )}
                    {selected.rootCause.needsDemoPatch && <span className="tag amber">需改 demo 验证</span>}
                  </div>
                  {isLegacyRuleCause(selected) && (
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--red-dim)', color: 'var(--red, #e5534b)', fontSize: 12, lineHeight: 1.7 }}>
                      ⚠️ 这是<b>改造前的降级产物</b>：当时 LLM 不可用，系统只把上下文里的线索罗列了一遍，
                      <b>没有做任何根因推断</b>——下面这段文字不是结论，下面的证据列表也只是线索清单，
                      照着它改代码等于照着猜的东西改。请点右上角「重新分析」用真实模型重跑。
                    </div>
                  )}
                  <div style={{ fontSize: 13, marginTop: 6 }}>{selected.rootCause.rootCause}</div>

                  {/* B3 分析过程（设计 §9.4）：假设 → 检查 → 结论 —— 报告第 4 节同款 */}
                  {(selected.rootCause.process?.length ?? 0) > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 11.5 }}>分析过程（怎么排除的）</div>
                      {selected.rootCause.process!.map((p, i) => (
                        <div key={i} style={{ fontSize: 12, marginTop: 3, paddingLeft: 8, borderLeft: '2px solid var(--border, #333)' }}>
                          <b>假设 {String.fromCharCode(65 + i)}</b>：{p.hypothesis}
                          <div className="muted">检查：{p.checked}</div>
                          <span className={`tag ${p.result === 'confirmed' ? 'green' : p.result === 'excluded' ? 'gray' : 'amber'}`} style={{ fontSize: 10 }}>
                            {p.result === 'confirmed' ? '成立' : p.result === 'excluded' ? '排除' : '不确定'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* B3 归因修正（设计 §10.7）：归因是主结论，人工修正必须留理由 */}
                  <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'var(--bg2)', fontSize: 12 }}>
                    <b style={{ fontSize: 12 }}>归因修正</b>
                    <span className="muted" style={{ fontSize: 11 }}> 当前：{ATTRIBUTION_LABEL[selected.attribution] ?? selected.attribution} · 修正留理由，历史可回查</span>
                    {selected.attributionReason && (
                      <div className="muted" style={{ fontSize: 10.5, marginTop: 3, whiteSpace: 'pre-wrap' }}>修正记录：{selected.attributionReason}</div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <select className="input" style={{ width: 200, fontSize: 12 }} value={attrPick} onChange={(e) => setAttrPick(e.target.value as IssueAttribution)}>
                        {ATTRIBUTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <input
                        className="input" style={{ flex: 1, minWidth: 200, fontSize: 12 }}
                        placeholder="修正理由（必填）：为什么改归因？"
                        value={attrReason} onChange={(e) => setAttrReason(e.target.value)}
                      />
                      <button className="btn sm" disabled={busy || !attrReason.trim() || attrPick === selected.attribution} onClick={() => void fixAttribution(selected.id)}>
                        修正
                      </button>
                    </div>
                  </div>

                  {selected.rootCause.fixSuggestions.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 11.5 }}>修复建议</div>
                      <ul style={{ margin: '3px 0 0 16px', padding: 0, fontSize: 12 }}>
                        {selected.rootCause.fixSuggestions.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}

                  {selected.rootCause.uncertainties.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 11.5 }}>AI 明确说"需要人确认"的（没有证据就不猜）</div>
                      <ul style={{ margin: '3px 0 0 16px', padding: 0, fontSize: 12 }}>
                        {selected.rootCause.uncertainties.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}

                  {selected.rootCause.evidence.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div className="muted" style={{ fontSize: 11.5 }}>证据（每条都可回查；没有证据的结论不该有高置信度）</div>
                      {selected.rootCause.evidence.map((e, i) => (
                        <div key={i} style={{ fontSize: 11.8, marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--border, #333)' }}>
                          <span className="tag gray">{e.kind}</span>{' '}
                          <span className="mono">{e.ref}{e.line > 0 ? `:${e.line}` : ''}</span>
                          <div className="muted">{e.supports}</div>
                          {e.excerpt && <pre className="mono" style={{ fontSize: 10.5, margin: '2px 0 0', whiteSpace: 'pre-wrap', opacity: 0.8 }}>{e.excerpt.slice(0, 200)}</pre>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 自测试结果 */}
              {selected.verification && Object.keys(selected.verification).length > 0 && (
                <div className="card" style={{ marginTop: 10 }}>
                  <b>自测试验证</b>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {(() => {
                      const v = selected.verification as { mode?: string; serial?: string; execution?: { passed?: boolean; stepCount?: number; passedSteps?: number; failureBrief?: string } };
                      if (v.mode === 'skipped_no_device' || v.mode === 'skipped_no_hdc') {
                        return (
                          <div>
                            <span className="tag amber">未验证</span>
                            <span className="muted"> 无在线真机（或未检测到 hdc）——按纪律**不回退模拟**，所以本次没有自测试结论。接上真机后可重新发起。</span>
                          </div>
                        );
                      }
                      if (v.mode === 'skipped_no_oracle') {
                        return <div><span className="tag amber">未验证</span><span className="muted"> 该用例没有机器判据（oracle），跑完也无法判定对错。</span></div>;
                      }
                      if (v.mode === 'skipped') {
                        return <div><span className="tag amber">未验证</span><span className="muted"> 该用例没有可执行步骤。</span></div>;
                      }
                      if (v.execution) {
                        return (
                          <div>
                            <span className={`tag ${v.execution.passed ? 'green' : 'red'}`}>
                              {v.execution.passed ? '真机复现通过' : '真机复现未通过'}
                            </span>
                            <span className="muted"> {v.execution.passedSteps ?? 0}/{v.execution.stepCount ?? 0} 步{v.serial ? ` · ${v.serial}` : ''}</span>
                            {v.execution.failureBrief && <div className="muted" style={{ fontSize: 11 }}>{v.execution.failureBrief.slice(0, 200)}</div>}
                          </div>
                        );
                      }
                      return <div className="muted">验证中…</div>;
                    })()}
                  </div>
                </div>
              )}

              {/* 验收操作 */}
              {selected.rootCause && !['accepted', 'rejected'].includes(selected.status) && (
                <div className="card" style={{ marginTop: 10 }}>
                  <b>人工验收</b>
                  <div className="muted" style={{ fontSize: 11.8, marginTop: 3 }}>
                    {selected.verification && (selected.verification as { mode?: string }).mode?.startsWith('skipped')
                      ? '⚠️ 本次自测试未执行（无真机/无判据）。验收通过表示你**人工确认**根因成立——结论仍会沉淀，但请知悉它没有真机证据。'
                      : '确认根因是否成立。通过则沉淀为知识条目（下次同类问题可召回）；驳回则留存理由供反查。'}
                  </div>
                  <textarea
                    className="input"
                    style={{ width: '100%', marginTop: 6, minHeight: 64 }}
                    placeholder="验收结论 / 驳回理由（必填）"
                    value={verdictText}
                    onChange={(e) => setVerdictText(e.target.value)}
                  />
                   <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                     <button className="btn sm primary" disabled={busy} onClick={() => void accept(selected.id)}>验收通过</button>
                     <button className="btn sm" disabled={busy} onClick={() => void reject(selected.id)}>驳回</button>
                   </div>
                 </div>
               )}
             </>
           )}
         </div>
       </div>

      {/* B3：分析报告列表（跨工单统一入口；正文走 .md 下载，不进列表 DTO） */}
      {reports !== null && reports.length > 0 && (
        <div className="card" style={{ marginTop: 4 }}>
          <div className="card-h" style={{ marginBottom: 8 }}>
            <span className="t">📄 分析报告</span>
            <span className="sub">不可变：重新生成产生新报告 · 共 {reports.length} 份</span>
          </div>
          <table className="tbl" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>编号</th><th>标题</th><th>类型</th><th>生成时间</th><th>来源</th><th />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{r.reportNo}</td>
                  <td style={{ fontSize: 12 }}>{r.title}</td>
                  <td><span className="tag gray">{r.kind}</span></td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{r.createdAt}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{r.createdBy || 'system'}</td>
                  <td>
                    <button className="btn sm" onClick={() => {
                      api.reportDownload(r.id).then((blob) => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${r.reportNo}.md`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }).catch((e) => setError(`报告下载失败：${(e as Error).message}`));
                    }}>⬇ 下载</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
     </>
  );
}
