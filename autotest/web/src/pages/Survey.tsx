import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 全量分析页（R2 新增，全量规模化的可观测面）。
 *
 * 这一页回答四个问题（对应重构方案 §0.5.4 的批次验收指标）：
 *   ① **跑没跑**：批次进度（总数/完成/失败/跳过/需 LLM）；
 *   ② **画像完整率**： surveyed / libraries —— 采集覆盖了多少库；
 *   ③ **预设命中率**：presetsMatched / surveyed —— 有多少库拿到了开箱方案（目标 ≥ 70%）；
 *   ④ **L2 触发率**：needsLlm / surveyed —— 有多少库真的需要 LLM（应随批次下降）。
 *
 * 为什么单独一页：全量是"348 个库"的量级，单库视角看不出来规模化成不成立。
 * 只有把这四个比率摆在一起，才能回答"这个平台是在变聪明还是在重复花钱"。
 */
export default function SurveyPage() {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.surveyStats>> | null>(null);
  const [presets, setPresets] = useState<Awaited<ReturnType<typeof api.surveyPresets>> | null>(null);
  const [resources, setResources] = useState<Awaited<ReturnType<typeof api.resources>> | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.surveyBatch>> | null>(null);
  const [tab, setTab] = useState<'overview' | 'batches' | 'resources'>('overview');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api.surveyStats().then(setStats).catch((e) => setError(String((e as Error).message)));
    api.surveyPresets().then(setPresets).catch(() => { /* 老后端无此接口时静默降级 */ });
    api.resources().then(setResources).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const runBatch = async (scope: 'all' | 'ids') => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.surveyBatchRun({ scope, concurrency: 4 });
      setMsg(`批次完成：共 ${r.total} · 完成 ${r.done} · 需 LLM ${r.needsLlm} · 失败 ${r.failed} · 跳过 ${r.skipped}（${(r.durationMs / 1000).toFixed(1)}s）`);
      setDetail(await api.surveyBatch(r.batchId));
      setTab('batches');
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const openBatch = async (id: number) => {
    setDetail(null);
    try { setDetail(await api.surveyBatch(id)); }
    catch (e) { setError(String((e as Error).message)); }
  };

  const synthesize = async (kind: string) => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.resourcesSynthesize(kind);
      setMsg(`已登记 ${r.registered} 个合成资源${r.problems ? `（${r.problems} 个为故意畸形，已标记）` : ''}`);
      api.resources().then(setResources).catch(() => {});
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>全量分析</div>
          <div className="page-desc">
            全量库 L0 画像采集 · 预设匹配 · 测试资源 —— 分层处理，AI 只做增量
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={load} disabled={busy}>刷新</button>
        <button className="btn primary" onClick={() => void runBatch('all')} disabled={busy}>
          {busy ? '采集中…' : '跑全量采集'}
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {/* ---------- 核心指标（规模化成不成立的判据）---------- */}
      {stats && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {[
              { label: '库总数', value: stats.totals.libraries, hint: '随包目录里的库' },
              { label: '已采集画像', value: `${stats.totals.surveyed}（${pct(stats.totals.surveyed, stats.totals.libraries)}）`, hint: '画像完整率' },
              { label: '预设命中', value: `${stats.totals.presetsMatched}（${pct(stats.totals.presetsMatched, Math.max(1, stats.totals.surveyed))}）`, hint: '拿到开箱方案的比例，目标 ≥70%' },
              { label: '需 LLM 增量', value: `${stats.totals.needsLlm}（${pct(stats.totals.needsLlm, Math.max(1, stats.totals.surveyed))}）`, hint: 'L2 触发率，应随批次下降' },
              { label: '采集失败', value: stats.totals.failed, hint: '多为仓库未 clone' },
            ].map((m) => (
              <div key={m.label}>
                <div className="muted" style={{ fontSize: 11.5 }}>{m.label}</div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{m.value}</div>
                <div className="muted" style={{ fontSize: 10.5 }}>{m.hint}</div>
              </div>
            ))}
          </div>

          {stats.byKind.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 6 }}><b>按库类别</b>（预设即按此分发）</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stats.byKind.map((k) => (
                  <span key={k.kind} className="tag blue">
                    {k.kind} {k.count}{k.needsLlm > 0 ? ` · 待 LLM ${k.needsLlm}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {([['overview', '概览'], ['batches', '批次记录'], ['resources', '测试资源']] as const).map(([k, label]) => (
          <button key={k} className={`btn sm ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/* ---------- 概览：预设与资源 ---------- */}
      {tab === 'overview' && (
        <div style={{ marginTop: 12 }}>
          <div className="card">
            <b>预设库</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              按库类别提供开箱方案（工具链 + 步骤序列 + 判据配方 + 资源清单）。
              预设命中即得方案，AI 只在差异库上工作——这是全量规模化的关键。
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {(presets?.kinds ?? []).map((k) => <span key={k} className="tag green">{k}</span>)}
              {(presets?.kinds ?? []).length === 0 && <span className="muted">（未检测到预设）</span>}
            </div>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b>测试资源</b>
              <div style={{ flex: 1 }} />
              <span className="muted" style={{ fontSize: 11.5 }}>
                共 {resources?.items.length ?? 0} 个已登记
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              三类来源：仓库检出 / 上游 canonical / 程序合成。全部带 sha256 与 schema 校验，
              <b>绝不现场编</b>——否则结果不可复现、无法回归。
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {['animation', 'network', 'storage', 'codec', 'ui_component'].map((k) => (
                <button key={k} className="btn sm" disabled={busy} onClick={() => void synthesize(k)}>
                  合成 {k} 资源
                </button>
              ))}
            </div>
            {(resources?.items ?? []).slice(0, 12).map((r) => (
              <div key={r.resourceId} style={{ fontSize: 11.8, marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--border, #333)' }}>
                <span className="mono">{r.resourceId}</span>{' '}
                <span className="tag gray">{r.origin}</span>{' '}
                {r.validated
                  ? <span className="tag green">校验通过</span>
                  : <span className="tag amber">{r.problems[0]?.slice(0, 40) ?? '未校验'}</span>}
                <span className="muted"> · {(r.size / 1024).toFixed(1)}KB · 复用 {r.reuseCount} 次</span>
                <div className="muted" style={{ fontSize: 10.5 }}>{r.intent}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 批次记录 ---------- */}
      {tab === 'batches' && (
        <div style={{ marginTop: 12 }}>
          {(stats?.batches ?? []).length === 0 && <div className="card muted">还没有采集批次。点右上角「跑全量采集」开始。</div>}
          {(stats?.batches ?? []).map((b) => (
            <div key={Number(b.id)} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b className="mono">{String(b.batch_no)}</b>
                <span className={`tag ${String(b.status) === 'passed' ? 'green' : String(b.status) === 'cancelled' ? 'amber' : 'gray'}`}>
                  {String(b.status)}
                </span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  共 {Number(b.total)} · 完成 {Number(b.done)} · 失败 {Number(b.failed)} · 跳过 {Number(b.skipped)} · 需 LLM {Number(b.needs_llm)}
                </span>
                <div style={{ flex: 1 }} />
                <span className="link" onClick={() => void openBatch(Number(b.id))}>明细</span>
              </div>

              {detail && detail.id === Number(b.id) && (
                <div style={{ marginTop: 8, maxHeight: 320, overflow: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="muted">
                        <td>库</td><td>状态</td><td>耗时</td><td>说明</td>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.runs.map((r) => (
                        <tr key={r.libraryId}>
                          <td className="mono">{r.libraryName}</td>
                          <td>
                            {r.status === 'done' && <span className="tag green">完成</span>}
                            {r.status === 'needs_llm' && <span className="tag blue">待 LLM</span>}
                            {r.status === 'failed' && <span className="tag red">失败</span>}
                            {r.status === 'running' && <span className="tag amber">进行中</span>}
                            {r.status === 'pending' && <span className="tag gray">等待</span>}
                          </td>
                          <td className="muted">{(r.durationMs / 1000).toFixed(1)}s</td>
                          <td className="muted">{r.failureWhat || r.llmReason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------- 测试资源 ---------- */}
      {tab === 'resources' && (
        <div style={{ marginTop: 12 }}>
          {(resources?.items ?? []).length === 0 && (
            <div className="card muted">还没有登记资源。在「概览」页点「合成 xx 资源」，或等全量采集发现仓库自带资源。</div>
          )}
          {(resources?.items ?? []).map((r) => (
            <div key={r.resourceId} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b className="mono">{r.resourceId}</b>
                <span className="tag gray">{r.kind}</span>
                <span className="tag gray">{r.origin}</span>
                {r.validated ? <span className="tag green">校验通过</span> : <span className="tag amber">有问题</span>}
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {(r.size / 1024).toFixed(1)}KB · 复用 {r.reuseCount} 次 · {r.sha256.slice(0, 8)}
                </span>
                {r.expiresAt && <span className="tag amber">到期 {r.expiresAt}</span>}
              </div>
              <div className="muted" style={{ fontSize: 11.8, marginTop: 4 }}>{r.intent}</div>
              {r.problems.length > 0 && (
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>
                  {r.problems.map((p) => <div key={p}>· {p}</div>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
