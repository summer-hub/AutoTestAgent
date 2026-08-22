import { useCallback, useEffect, useState } from 'react';
import type { Analysis, Execution, Library } from 'shared';
import { api } from '../api';

const GRANULARITY: Array<{ v: 'single' | 'lib' | 'multi'; label: string; desc: string }> = [
  { v: 'single', label: '单用例', desc: '针对单个失败用例归因' },
  { v: 'lib', label: '单库', desc: '整个三方库用例集中失败原因' },
  { v: 'multi', label: '多库', desc: '多个库失败原因聚合' },
];

export default function AttributionPage() {
  const [granularity, setGranularity] = useState<'single' | 'lib' | 'multi'>('single');
  const [libs, setLibs] = useState<Library[]>([]);
  const [curLib, setCurLib] = useState<number | null>(null);
  const [failed, setFailed] = useState<Array<Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null }>>([]);
  const [curExec, setCurExec] = useState<number | null>(null);
  const [rows, setRows] = useState<Analysis[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const loadLibs = useCallback(() => {
    api.libraries({ pageSize: 100 })
      .then((r) => { setLibs(r.items); setCurLib((prev) => prev ?? r.items[0]?.id ?? null); })
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  const loadFailed = useCallback(() => {
    api.executions({ status: 'failed', limit: 50 })
      .then((r) => { setFailed(r); setCurExec((prev) => prev ?? r[0]?.id ?? null); })
      .catch(() => {});
  }, []);

  useEffect(() => { loadLibs(); loadFailed(); }, [loadLibs, loadFailed]);
  useEffect(() => { api.analyses({ kind: 'attribution' }).then(setRows).catch(() => {}); }, []);

  const run = async () => {
    setBusy(true); setMsg(''); setError('');
    const sel = failed.find((e) => e.id === curExec);
    try {
      const r = await api.runAttribution({
        granularity,
        libraryId: granularity === 'lib' ? curLib ?? undefined : sel?.libraryId ?? undefined,
        caseId: granularity === 'single' ? sel?.caseId ?? undefined : undefined,
      });
      setMsg(`${r.message}${r.source === 'fallback' ? '（规则降级，配置 DSH 模型后自动升级为 AI 归因）' : ''}`);
      api.analyses({ kind: 'attribution' }).then(setRows).catch(() => {});
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (a: Analysis) => {
    const c = a.content ?? {};
    return (
      <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="card-h" style={{ marginBottom: 0 }}>
          <span className="t">{a.title}</span>
          <span className={`tag ${a.granularity === 'single' ? 'blue' : a.granularity === 'lib' ? 'amber' : 'purple'}`}>
            {{ single: '单用例', lib: '单库', multi: '多库' }[a.granularity] ?? a.granularity}
          </span>
          <span className="sub">{a.createdAt}</span>
        </div>
        {c.conclusion && (
          <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)' }}>
            <b>结论：</b>{c.conclusion}
          </div>
        )}
        {Array.isArray(c.rootCauses) && c.rootCauses.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11.5 }}>
            {c.rootCauses.map((r: string, i: number) => <span key={i} className="tag red">{r}</span>)}
          </div>
        )}
        {Array.isArray(c.evidence) && c.evidence.length > 0 && (
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--text2)' }}>依据：</b>
            <ul style={{ margin: '4px 0 0 18px' }}>
              {c.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}
        {Array.isArray(c.suggestions) && c.suggestions.length > 0 && (
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--text2)' }}>建议：</b>
            <ul style={{ margin: '4px 0 0 18px' }}>
              {c.suggestions.map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="page-title">归因分析</div>
      <div className="page-desc">
        测试用例执行失败的归因分析：单用例 → 单库 → 多库三粒度，AI 跟踪分析根因（基于失败执行记录 + 思考过程）
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {GRANULARITY.map((g) => (
            <button
              key={g.v}
              className={`btn ${granularity === g.v ? 'primary' : ''}`}
              title={g.desc}
              onClick={() => setGranularity(g.v)}
            >
              {g.label}
            </button>
          ))}
        </div>

        {granularity === 'single' && (
          <>
            <span className="muted" style={{ fontSize: 12.5 }}>失败用例：</span>
            <select className="select" style={{ width: 320 }} value={curExec ?? ''} onChange={(e) => setCurExec(Number(e.target.value))}>
              {failed.length === 0 && <option value="">暂无失败执行记录</option>}
              {failed.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.libraryName}/{e.caseNo} · {e.caseName} · 执行 #{e.id}
                </option>
              ))}
            </select>
          </>
        )}
        {granularity === 'lib' && (
          <>
            <span className="muted" style={{ fontSize: 12.5 }}>三方库：</span>
            <select className="select" style={{ width: 260 }} value={curLib ?? ''} onChange={(e) => setCurLib(Number(e.target.value))}>
              {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </>
        )}
        <button className="btn primary" disabled={busy} onClick={run}>
          {busy ? '归因分析中…' : '🧠 开始归因分析'}
        </button>
        <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>历史归因 {rows.length} 条</span>
      </div>

      <div className="page-desc" style={{ marginBottom: 10 }}>归因结果（按时间倒序）</div>
      {rows.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28, fontSize: 12.5 }}>
          暂无归因结果。先让执行计划产生失败用例（当前种子含 ~6% 失败率），再点「开始归因分析」。
        </div>
      ) : (
        <div className="grid grid-2">{rows.map(renderRow)}</div>
      )}
    </>
  );
}
