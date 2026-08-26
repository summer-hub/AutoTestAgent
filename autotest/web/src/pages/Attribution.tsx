// 归因分析：自由勾选失败用例（单条 / 多条跨库 / 库级全选 / 全部库）→ AI 归因
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Analysis, Execution } from 'shared';
import { api } from '../api';

type FailedExec = Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null };

export default function AttributionPage() {
  const [failed, setFailed] = useState<FailedExec[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set()); // execution id 勾选
  const [rows, setRows] = useState<Analysis[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [libFilter, setLibFilter] = useState(''); // 按库快速筛选视图

  const load = useCallback(() => {
    api.executions({ status: 'failed', limit: 100 })
      .then((r) => { setFailed(r); setSel(new Set()); })
      .catch((e) => setError(String((e as Error).message)));
    api.analyses({ kind: 'attribution' }).then(setRows).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const libs = useMemo(() => [...new Set(failed.map((f) => f.libraryName))].sort(), [failed]);
  const visible = libFilter ? failed.filter((f) => f.libraryName === libFilter) : failed;
  // 跨库去重后的 caseId 集合（同一用例多次失败只归因一次）
  const selCaseIds = useMemo(() => {
    const ids = new Set<number>();
    for (const f of failed) if (sel.has(f.id)) ids.add(f.caseId);
    return [...ids];
  }, [failed, sel]);

  const selLibs = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of failed) if (sel.has(f.id)) m.set(f.libraryName, (m.get(f.libraryName) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [failed, sel]);

  const toggle = (id: number): void => {
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const selectAllVisible = (): void => setSel((s) => { const n = new Set(s); visible.forEach((f) => n.add(f.id)); return n; });
  const clearSel = (): void => setSel(new Set());

  const run = async (): Promise<void> => {
    if (sel.size === 0) { setError('请先在下方勾选要归因的失败执行记录'); return; }
    setBusy(true); setMsg(''); setError('');
    try {
      // 勾选用例 → caseIds；若某库全部失败记录都被勾选 → 视为库级选择
      const libCounts = new Map<string, { total: number; picked: number; id: number }>();
      for (const f of failed) {
        const e = libCounts.get(f.libraryName) ?? { total: 0, picked: 0, id: f.libraryId };
        e.total++; if (sel.has(f.id)) e.picked++;
        libCounts.set(f.libraryName, e);
      }
      const fullLibs = [...libCounts.entries()].filter(([, v]) => v.picked > 0 && v.picked === v.total).map(([k]) => libCounts.get(k)!.id);
      const partialCaseLibs = new Set([...libCounts.entries()].filter(([, v]) => v.picked > 0 && v.picked < v.total).map(([k]) => k));
      const caseIdsForPartial = failed.filter((f) => partialCaseLibs.has(f.libraryName) && sel.has(f.id)).map((f) => f.caseId);

      const r = await api.runAttribution({
        caseIds: caseIdsForPartial.length > 0 ? caseIdsForPartial : undefined,
        libraryIds: fullLibs.length > 0 && caseIdsForPartial.length === 0 ? fullLibs : undefined,
        allLibraries: false,
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
          <span className="sub">{a.createdAt}</span>
        </div>
        {c.conclusion && (
          <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)' }}><b>结论：</b>{c.conclusion}</div>
        )}
        {Array.isArray(c.rootCauses) && c.rootCauses.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11.5 }}>
            {c.rootCauses.map((r: string, i: number) => <span key={i} className="tag red">{r}</span>)}
          </div>
        )}
        {Array.isArray(c.evidence) && c.evidence.length > 0 && (
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--text2)' }}>依据：</b>
            <ul style={{ margin: '4px 0 0 18px' }}>{c.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
        {Array.isArray(c.suggestions) && c.suggestions.length > 0 && (
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--text2)' }}>建议：</b>
            <ul style={{ margin: '4px 0 0 18px' }}>{c.suggestions.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="page-title">归因分析</div>
      <div className="page-desc">勾选任意失败的执行记录进行 AI 归因：单条、多条跨库、整库全选或全部库，自由组合</div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {/* 范围操作条 */}
      <div className="card" style={{ marginBottom: 14, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 200 }} value={libFilter} onChange={(e) => setLibFilter(e.target.value)}>
          <option value="">全部库（{libs.length}）</option>
          {libs.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <button className="btn sm" onClick={() => selectAllVisible()}>☑ 全选{libFilter ? `「${libFilter}」` : '当前列表'}</button>
        <button className="btn sm" onClick={() => { const n = new Set<number>(); failed.forEach((f) => n.add(f.id)); setSel(n); }}>🌐 选择全部库所有失败</button>
        {sel.size > 0 && (
          <>
            <span className="tag blue">已选 {sel.size} 条 · 涉及 {selLibs.length} 个库 · 去重后 {selCaseIds.length} 条用例</span>
            {selLibs.slice(0, 4).map(([l, n]) => <span key={l} className="tag plain" style={{ fontSize: 11 }}>{l}×{n}</span>)}
            <button className="btn sm ghost" onClick={clearSel}>取消选择</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || sel.size === 0} onClick={() => void run()}>
          {busy ? '归因分析中…' : `🧠 开始归因分析${sel.size > 0 ? `（${sel.size} 条）` : ''}`}
        </button>
      </div>

      {/* 失败执行记录（勾选） */}
      <div className="card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="card-h" style={{ marginBottom: 8 }}>
          <span className="t">失败执行记录（{failed.length}）</span>
          <span className="sub">勾选后点击上方按钮发起归因 · 同一用例多条失败会聚合</span>
        </div>
        {failed.length === 0 ? (
          <div className="loading">暂无失败执行记录。先运行执行计划产生失败用例。</div>
        ) : (
          <table>
            <thead><tr><th style={{ width: 36 }}></th><th>库</th><th>用例</th><th>设备</th><th>时间</th></tr></thead>
            <tbody>
              {visible.map((f) => (
                <tr key={f.id} onClick={() => toggle(f.id)} style={{ cursor: 'pointer' }}>
                  <td><input type="checkbox" checked={sel.has(f.id)} onChange={() => toggle(f.id)} onClick={(e) => e.stopPropagation()} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} /></td>
                  <td>{f.libraryName}</td>
                  <td><span className="mono" style={{ color: 'var(--accent2)', marginRight: 6 }}>{f.caseNo}</span>{f.caseName}{sel.has(f.id) && f.caseNo && <span className="tag blue" style={{ marginLeft: 6 }}>已选</span>}</td>
                  <td className="mono muted" style={{ fontSize: 11.5 }}>{f.deviceSerial ?? '—'}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{(f.startedAt ?? '').replace('T', ' ').slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="page-desc" style={{ marginBottom: 10 }}>归因结果（按时间倒序）</div>
      {rows.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28, fontSize: 12.5 }}>
          暂无归因结果。勾选上方失败记录后点「开始归因分析」。
        </div>
      ) : (
        <div className="grid grid-2">{rows.map(renderRow)}</div>
      )}
    </>
  );
}
