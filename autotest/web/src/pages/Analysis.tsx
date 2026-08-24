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
  const [prSel, setPrSel] = useState<number[]>([]);
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
    setPrSel([]);
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
    const parsed = prInput
      .split(/[,#\s，]+/)
      .map((s) => Number(s.trim().replace(/^#/, '')))
      .filter((n) => Number.isInteger(n) && n > 0);
    const prNumbers = Array.from(new Set([...prSel, ...parsed]));
    setPrModal(null);
    setMsg(''); setError('');
    setRunning(true);
    setStage('准备分析…');
    try {
      const r = kind === 'pr' ? await api.runPrAnalysis(curLib, prNumbers) : await api.runCaseUpdateAnalysis(curLib, prNumbers);
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

  const removeAnalysis = async (a: Analysis) => {
    if (!window.confirm(`确认删除分析结果「${a.title}」？`)) return;
    try {
      await api.deleteAnalysis(a.id);
      if (curLib !== null) loadRows(curLib);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const removeRound = async (round: string) => {
    if (!window.confirm('确认删除这一轮的全部分析结果？')) return;
    try {
      await api.deleteAnalysisRound(round);
      if (curLib !== null) loadRows(curLib);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const clearLibrary = async () => {
    if (curLib === null) return;
    if (!window.confirm(`确认清空「${libs.find((l) => l.id === curLib)?.name}」的全部历史分析？`)) return;
    try {
      await api.deleteLibraryAnalyses(curLib);
      loadRows(curLib);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const exportExcel = async () => {
    try {
      const blob = await api.exportAnalyses({ libraryId: curLib ?? undefined });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `分析结果_${libs.find((l) => l.id === curLib)?.name ?? '全部'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  // 按扫描轮次分组（同一轮扫描的所有 PR 卡片归到一起，可整体删除）
  const groupByRound = (rows: Analysis[]): Array<[string, Analysis[]]> => {
    const m = new Map<string, Analysis[]>();
    for (const r of rows) {
      const k = r.round || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries());
  };

  const roundLabel = (round: string) => {
    if (!round) return '历史记录（升级前）';
    const m = round.match(/^R-(\d+)/);
    if (m) {
      const d = new Date(Number(m[1]));
      const p = (n: number) => String(n).padStart(2, '0');
      return `扫描 ${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    return round;
  };

  // 详情内容：按类型渲染成可读视图，而不是裸 JSON
  const renderDetail = (a: Analysis) => {
    const c = a.content ?? {};
    if (a.kind === 'pr_analysis') {
      return (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-h">
              <span className="t" style={{ fontSize: 15 }}>PR #{c.prNumber} · {String(c.title ?? '')}</span>
              <span className={`tag ${STATE_TAG[String(c.state ?? '')] ?? 'gray'}`}>{String(c.state ?? '')}</span>
              <span className={`tag ${RISK_TAG[String(c.risk ?? '')] ?? 'gray'}`}>风险 {String(c.risk ?? '—')}</span>
            </div>
            {c.webUrl && <a className="link" style={{ fontSize: 12.5 }} href={String(c.webUrl)} target="_blank" rel="noreferrer">查看 PR ↗</a>}
          </div>
          <Block title="📌 更新点" list={c.updatePoints} />
          <Block title="🌊 影响范围" text={c.impact} />
          <Block title="🧩 受影响功能" tags={c.affectedFeatures} />
          <Block title="💡 建议用例更新" list={c.suggestedCaseUpdates} />
        </>
      );
    }
    if (a.kind === 'case_update_analysis') {
      return (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-h">
              <span className="t" style={{ fontSize: 15 }}>{c.caseNo ? `用例 ${c.caseNo}` : '新增用例'}</span>
              <span className="tag plain">{a.createdAt?.slice(0, 16)}</span>
            </div>
          </div>
          <Block title="📋 更新原因" text={c.reason} />
          <Block title="⚙️ 建议动作" text={c.suggestedAction} />
          <Block title="🎯 更新后预期" text={c.newExpected} />
        </>
      );
    }
    return <FieldRows data={c} />;
  };

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
        <button className="btn" disabled={curLib === null} onClick={() => void clearLibrary()} title="删除该三方库全部历史分析">🗑 清空该库</button>
        <button className="btn" disabled={curLib === null} onClick={() => void exportExcel()} title="导出当前库的全部分析结果（Excel）">📥 导出 Excel</button>
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
        <div style={{ marginBottom: 22 }}>
          {groupByRound(prRows).map(([round, rows]) => (
            <div key={round || 'legacy'} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>⏱ {roundLabel(round)}</span>
                <span className="tag plain">{rows.length} 条</span>
                {round !== '' && (
                  <button className="btn sm" style={{ color: 'var(--red)', marginLeft: 'auto' }} onClick={() => void removeRound(round)}>删除本轮</button>
                )}
              </div>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {rows.map((a) => {
                  const c = a.content ?? {};
                  return (
                    <div key={a.id} className="card" style={{ cursor: 'pointer', padding: 12 }} onClick={() => setDetail(a)}>
                      <div className="card-h" style={{ marginBottom: 6 }}>
                        <span className="t" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>PR #{c.prNumber} · {c.title ?? a.title}</span>
                        <span className="link" style={{ fontSize: 11.5, color: 'var(--red)', flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); void removeAnalysis(a); }}>删除</span>
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
            </div>
          ))}
        </div>
      )}

      <div className="page-desc" style={{ marginBottom: 10 }}>用例更新分析（结合 PR 变更点与现有用例）</div>
      {caseRows.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28, fontSize: 12.5 }}>
          暂无用例更新建议，点「用例更新分析」生成
        </div>
      ) : (
        <div>
          {groupByRound(caseRows).map(([round, rows]) => (
            <div key={round || 'legacy'} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>⏱ {roundLabel(round)}</span>
                <span className="tag plain">{rows.length} 条</span>
                {round !== '' && (
                  <button className="btn sm" style={{ color: 'var(--red)', marginLeft: 'auto' }} onClick={() => void removeRound(round)}>删除本轮</button>
                )}
              </div>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {rows.map((a) => {
                  const c = a.content ?? {};
                  return (
                    <div key={a.id} className="card" style={{ cursor: 'pointer', padding: 12 }} onClick={() => setDetail(a)}>
                      <div className="card-h" style={{ marginBottom: 6 }}>
                        <span className="t" style={{ fontSize: 13 }}>{c.caseNo ? `用例 ${c.caseNo}` : '新增用例'}</span>
                        <span className="tag plain">{a.createdAt?.slice(0, 16)}</span>
                        <span className="link" style={{ fontSize: 11.5, color: 'var(--red)', marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); void removeAnalysis(a); }}>删除</span>
                      </div>
                      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, maxHeight: 34, overflow: 'hidden' }}>{caseSummary(a)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
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
                <input className="input mono" style={{ flex: 1 }} placeholder="#123,#456（留空 = 分析全部；也可点选下方多选）" value={prInput} onChange={(e) => setPrInput(e.target.value)} />
                <button className="btn primary" onClick={() => void startAnalysis(prModal)}>开始分析</button>
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>已选 {prSel.length} 个 PR：{prSel.length > 0 ? prSel.map((n) => `#${n}`).join('、') : '（全部最近 PR）'}</div>
              {prLoading && <div className="loading">拉取 PR 列表…</div>}
              {!prLoading && prList.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>仓库暂无 PR，或拉取失败</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {prList.map((p) => (
                  <div key={p.number}
                    onClick={() => setPrSel((prev) => (prev.includes(p.number) ? prev.filter((n) => n !== p.number) : [...prev, p.number]))}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', background: prSel.includes(p.number) ? 'var(--accent-dim)' : 'transparent' }}>
                    <span style={{ width: 16, textAlign: 'center', fontSize: 12, color: prSel.includes(p.number) ? 'var(--accent2)' : 'var(--text3)' }}>{prSel.includes(p.number) ? '✓' : ''}</span>
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
              <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => { void removeAnalysis(detail); setDetail(null); }}>删除</button>
              <button className="s-header x" onClick={() => setDetail(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '16px 18px', overflowY: 'auto' }}>
              {renderDetail(detail)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Block({ title, text, list, tags }: { title: string; text?: unknown; list?: unknown; tags?: unknown }) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><span className="t">{title}</span></div>
      {Array.isArray(list) && list.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8, color: 'var(--text2)' }}>
          {list.map((x, i) => <li key={i}>{String(x)}</li>)}
        </ul>
      ) : Array.isArray(tags) && tags.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tags.map((x, i) => <span key={i} className="tag blue">{String(x)}</span>)}
        </div>
      ) : text ? (
        <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{String(text)}</div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>—</div>
      )}
    </div>
  );
}

function FieldRows({ data }: { data: Record<string, unknown> }) {
  const labels: Record<string, string> = {
    prNumber: 'PR 编号', title: '标题', state: '状态', risk: '风险等级',
    updatePoints: '更新点', impact: '影响范围', affectedFeatures: '受影响功能',
    suggestedCaseUpdates: '建议用例更新', webUrl: 'PR 链接', caseNo: '用例编号',
    reason: '更新原因', suggestedAction: '建议动作', newExpected: '更新后预期',
  };
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{labels[k] ?? k}</div>
          {Array.isArray(v) && v.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8, color: 'var(--text2)' }}>
              {v.map((x, i) => <li key={i}>{typeof x === 'object' ? JSON.stringify(x) : String(x)}</li>)}
            </ul>
          ) : typeof v === 'object' && v !== null ? (
            <FieldRows data={v as Record<string, unknown>} />
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{String(v)}</div>
          )}
        </div>
      ))}
    </div>
  );
}
