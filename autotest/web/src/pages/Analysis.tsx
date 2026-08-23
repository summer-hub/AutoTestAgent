import { useCallback, useEffect, useRef, useState } from 'react';
import type { Analysis, Library } from 'shared';
import { api } from '../api';

const RISK_TAG: Record<string, string> = { high: 'red', medium: 'amber', low: 'green' };
const STATE_TAG: Record<string, string> = { merged: 'green', open: 'blue', closed: 'gray' };

export default function AnalysisPage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [curLib, setCurLib] = useState<number | null>(null);
  const [prRows, setPrRows] = useState<Analysis[]>([]);
  const [caseRows, setCaseRows] = useState<Analysis[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const [prModal, setPrModal] = useState<null | 'pr' | 'case'>(null);
  const [prList, setPrList] = useState<Array<{ number: number; title: string; state: string; createdAt: string }>>([]);
  const [prInput, setPrInput] = useState('');
  const [prLoading, setPrLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [detail, setDetail] = useState<Analysis | null>(null);

  const loadLibs = useCallback(() => {
    api.libraries({ pageSize: 100 })
      .then((r) => {
        setLibs(r.items);
        const turbo = r.items.find((l) => l.name === 'lottie_turbo');
        setCurLib((prev) => prev ?? (turbo ?? r.items[0])?.id ?? null);
      })
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  const loadRows = useCallback((libraryId: number) => {
    api.analyses({ kind: 'pr_analysis', libraryId }).then(setPrRows).catch(() => {});
    api.analyses({ kind: 'case_update_analysis', libraryId }).then(setCaseRows).catch(() => {});
  }, []);

  useEffect(() => { loadLibs(); }, [loadLibs]);
  useEffect(() => { if (curLib !== null) loadRows(curLib); }, [curLib, loadRows]);

  const openPrModal = async (kind: 'pr' | 'case') => {
    if (curLib === null) return;
    setPrModal(kind);
    setPrInput('');
    setError('');
    setPrLoading(true);
    setPrList([]);
    try {
      const r = await api.libraryPrs(curLib);
      setPrList(r.items);
      if (r.error) setError(r.error);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setPrLoading(false);
    }
  };

  const startAnalysis = async (kind: 'pr' | 'case') => {
    if (curLib === null) return;
    let prNumber: number | undefined;
    const raw = prInput.trim().replace(/^#/, '');
    if (raw) {
      prNumber = Number(raw);
      if (!Number.isInteger(prNumber) || prNumber <= 0) { setError('请输入有效的 PR 编号（如 #123）'); return; }
    }
    setPrModal(null);
    setMsg(''); setError('');
    setRunning(true);
    setStage('准备分析…');
    try {
      const r = kind === 'pr' ? await api.runPrAnalysis(curLib, prNumber) : await api.runCaseUpdateAnalysis(curLib, prNumber);
      const runId = r.runId;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const p = await api.analysisProgress(runId);
          setStage(p.stage);
          if (p.done) {
            if (pollRef.current) clearInterval(pollRef.current);
            setRunning(false);
            if (p.error) setError(p.error);
            else { setMsg(p.stage); loadRows(curLib); loadLibs(); }
          }
        } catch {
          if (pollRef.current) clearInterval(pollRef.current);
          setRunning(false);
          setError('分析进度查询失败');
        }
      }, 800);
    } catch (e) {
      setRunning(false);
      setError(String((e as Error).message));
    }
  };

  const prSummary = (a: Analysis): string => {
    const c = a.content ?? {};
    if (Array.isArray(c.updatePoints) && c.updatePoints.length > 0) return String(c.updatePoints[0]);
    return String(c.impact ?? a.title);
  };
  const caseSummary = (a: Analysis): string => String((a.content ?? {}).reason ?? a.title);

  return (
    <>
      <div className="page-title">数据分析</div>
      <div className="page-desc">
        三方库 PR 更新分析 · 测试用例更新分析（可选择具体 PR，AI 生成更新点与影响范围）
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5 }}>三方库：</span>
        <select className="select" style={{ width: 260 }} value={curLib ?? ''} onChange={(e) => setCurLib(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.name === 'lottie_turbo' ? ' ★' : ''}</option>)}
        </select>
        <button className="btn primary" disabled={curLib === null} onClick={() => void openPrModal('pr')}>🔍 拉取并分析 PR</button>
        <button className="btn" disabled={curLib === null} onClick={() => void openPrModal('case')}>📝 用例更新分析</button>
        <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
          {curLib === null ? '' : `${libs.find((l) => l.id === curLib)?.name} · PR 分析 ${prRows.length} 条 / 用例更新建议 ${caseRows.length} 条`}
        </span>
      </div>

      <div className="page-desc" style={{ marginBottom: 10 }}>PR 更新分析（lottie_turbo 真实仓库：GitCode API 拉取 + AI 分析）</div>
      {prRows.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28, fontSize: 12.5 }}>
          暂无 PR 分析结果，点「拉取并分析 PR」生成
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', marginBottom: 22 }}>
          {prRows.map((a) => {
            const c = a.content ?? {};
            return (
              <div key={a.id} className="card" style={{ cursor: 'pointer', padding: 12 }} onClick={() => setDetail(a)}>
                <div className="card-h" style={{ marginBottom: 6 }}>
                  <span className="t" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>PR #{c.prNumber} · {c.title ?? a.title}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span className={`tag ${STATE_TAG[c.state ?? ''] ?? 'gray'}`}>{c.state ?? ''}</span>
                  <span className={`tag ${RISK_TAG[c.risk ?? ''] ?? 'gray'}`}>风险 {c.risk ?? '—'}</span>
                  <span className="tag plain">{a.createdAt?.slice(0, 16)}</span>
                </div>
                <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, maxHeight: 34, overflow: 'hidden' }}>{prSummary(a)}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="page-desc" style={{ marginBottom: 10 }}>用例更新分析（结合 PR 变更点与现有用例）</div>
      {caseRows.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28, fontSize: 12.5 }}>
          暂无用例更新建议，点「用例更新分析」生成
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {caseRows.map((a) => {
            const c = a.content ?? {};
            return (
              <div key={a.id} className="card" style={{ cursor: 'pointer', padding: 12 }} onClick={() => setDetail(a)}>
                <div className="card-h" style={{ marginBottom: 6 }}>
                  <span className="t" style={{ fontSize: 13 }}>{c.caseNo ? `用例 ${c.caseNo}` : '新增用例'}</span>
                  <span className="tag plain">{a.createdAt?.slice(0, 16)}</span>
                </div>
                <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, maxHeight: 34, overflow: 'hidden' }}>{caseSummary(a)}</div>
              </div>
            );
          })}
        </div>
      )}

      {prModal && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setPrModal(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 640, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{prModal === 'pr' ? '🔍 选择要分析的 PR' : '📝 选择 PR 做用例更新分析'}</span>
              <span className="muted" style={{ fontSize: 12 }}>可点击下方 PR，或输入 #编号</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setPrModal(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" style={{ flex: 1 }} placeholder="#123（留空 = 分析全部最近 PR）" value={prInput} onChange={(e) => setPrInput(e.target.value)} />
                <button className="btn primary" onClick={() => void startAnalysis(prModal)}>开始分析</button>
              </div>
              {prLoading && <div className="loading">拉取 PR 列表…</div>}
              {!prLoading && prList.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>仓库暂无 PR，或拉取失败</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {prList.map((p) => (
                  <div key={p.number}
                    onClick={() => { setPrInput(String(p.number)); }}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', background: prInput === String(p.number) ? 'var(--accent-dim)' : 'transparent' }}>
                    <span className="mono" style={{ color: 'var(--accent2)', fontSize: 12 }}>#{p.number}</span>
                    <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                    <span className={`tag ${STATE_TAG[p.state] ?? 'gray'}`}>{p.state}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {running && (
        <div className="s-overlay show">
          <div className="s-mask" />
          <div style={{ position: 'relative', zIndex: 1, width: 380, background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, padding: '26px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, boxShadow: '0 24px 80px rgba(0,0,0,.55)' }}>
            <div className="ana-spinner" />
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>正在分析中…</div>
            <div className="muted" style={{ fontSize: 12.5, minHeight: 18, textAlign: 'center' }}>{stage}</div>
            <div className="ana-bar" style={{ width: '100%' }} />
            <div className="muted" style={{ fontSize: 11 }}>AI 分析通常需要 30~120 秒，请稍候</div>
          </div>
        </div>
      )}

      {detail && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setDetail(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 720, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{detail.title}</span>
              <span className="tag plain">{detail.createdAt}</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setDetail(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '16px 18px', overflowY: 'auto' }}>
              <pre className="mono" style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(detail.content ?? {}, null, 2)}</pre>
              {(detail.content as { webUrl?: string })?.webUrl && (
                <a className="link" style={{ fontSize: 12.5 }} href={(detail.content as { webUrl: string }).webUrl} target="_blank" rel="noreferrer">查看 PR ↗</a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
