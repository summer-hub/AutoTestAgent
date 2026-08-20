import { useCallback, useEffect, useState } from 'react';
import type { Analysis, Library } from 'shared';
import { api } from '../api';

const RISK_TAG: Record<string, string> = { high: 'red', medium: 'amber', low: 'green' };
const STATE_TAG: Record<string, string> = { merged: 'green', open: 'blue', closed: 'gray' };

export default function AnalysisPage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [curLib, setCurLib] = useState<number | null>(null);
  const [prRows, setPrRows] = useState<Analysis[]>([]);
  const [caseRows, setCaseRows] = useState<Analysis[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

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

  const run = async (kind: 'pr' | 'case') => {
    if (curLib === null) return;
    setBusy(kind); setMsg(''); setError('');
    try {
      const r = kind === 'pr' ? await api.runPrAnalysis(curLib) : await api.runCaseUpdateAnalysis(curLib);
      setMsg(`${r.message}${r.source === 'fallback' ? '（规则降级，配置 DSH 模型后自动升级为 AI 分析）' : ''}`);
      loadRows(curLib);
      loadLibs();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy('');
    }
  };

  const renderPr = (a: Analysis) => {
    const c = a.content ?? {};
    return (
      <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="card-h" style={{ marginBottom: 0 }}>
          <span className="t">PR #{c.prNumber} · {c.title ?? a.title}</span>
          <span className={`tag ${STATE_TAG[c.state ?? ''] ?? 'gray'}`}>{c.state ?? ''}</span>
          <span className={`tag ${RISK_TAG[c.risk ?? ''] ?? 'gray'}`}>风险 {c.risk ?? '—'}</span>
        </div>
        {Array.isArray(c.updatePoints) && c.updatePoints.length > 0 && (
          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--text2)' }}>更新点：</b>
            <ul style={{ margin: '4px 0 0 18px' }}>
              {c.updatePoints.map((p: string, i: number) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}
        {c.impact && <div className="muted" style={{ fontSize: 12.5 }}><b style={{ color: 'var(--text2)' }}>影响：</b>{c.impact}</div>}
        {Array.isArray(c.affectedFeatures) && c.affectedFeatures.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11.5 }}>
            {c.affectedFeatures.map((f: string, i: number) => <span key={i} className="tag blue">{f}</span>)}
          </div>
        )}
        {Array.isArray(c.suggestedCaseUpdates) && c.suggestedCaseUpdates.length > 0 && (
          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--text2)' }}>建议用例更新：</b>
            <ul style={{ margin: '4px 0 0 18px' }}>
              {c.suggestedCaseUpdates.map((p: string, i: number) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}
        {c.webUrl && <a className="link" style={{ fontSize: 12 }} href={c.webUrl} target="_blank" rel="noreferrer">查看 PR ↗</a>}
      </div>
    );
  };

  const renderCase = (a: Analysis) => {
    const c = a.content ?? {};
    return (
      <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="card-h" style={{ marginBottom: 0 }}>
          <span className="t">{c.caseNo ? `用例 ${c.caseNo}` : '新增用例'}</span>
          <span className="sub">{a.createdAt}</span>
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          <b style={{ color: 'var(--text2)' }}>原因：</b>{c.reason ?? ''}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          <b style={{ color: 'var(--text2)' }}>建议动作：</b>{c.suggestedAction ?? ''}
        </div>
        {c.newExpected && <div className="muted" style={{ fontSize: 12.5 }}><b style={{ color: 'var(--text2)' }}>预期结果：</b>{c.newExpected}</div>}
      </div>
    );
  };

  return (
    <>
      <div className="page-title">数据分析</div>
      <div className="page-desc">
        三方库 PR 更新分析 · 测试用例更新分析（AI 生成更新点与影响范围，全部结果存入 analyses 表）
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5 }}>三方库：</span>
        <select className="select" style={{ width: 260 }} value={curLib ?? ''} onChange={(e) => setCurLib(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.name === 'lottie_turbo' ? ' ★' : ''}</option>)}
        </select>
        <button className="btn primary" disabled={busy !== '' || curLib === null} onClick={() => run('pr')}>
          {busy === 'pr' ? '分析中…' : '🔍 拉取并分析 PR'}
        </button>
        <button className="btn" disabled={busy !== '' || curLib === null} onClick={() => run('case')}>
          {busy === 'case' ? '分析中…' : '📝 用例更新分析'}
        </button>
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
        <div className="grid grid-2" style={{ marginBottom: 22 }}>{prRows.map(renderPr)}</div>
      )}

      <div className="page-desc" style={{ marginBottom: 10 }}>用例更新分析（结合 PR 变更点与现有用例）</div>
      {caseRows.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28, fontSize: 12.5 }}>
          暂无用例更新建议，点「用例更新分析」生成
        </div>
      ) : (
        <div className="grid grid-2">{caseRows.map(renderCase)}</div>
      )}
    </>
  );
}
