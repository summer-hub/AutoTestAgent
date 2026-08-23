import { useCallback, useEffect, useState } from 'react';
import type { RepoFile, RepoFileEntry } from 'shared';
import { api } from '../api';

interface ScriptLib { id: number; name: string; dir: string; exists: boolean; fileCount: number; }

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

export default function ScriptsPage() {
  const [libs, setLibs] = useState<ScriptLib[]>([]);
  const [curLib, setCurLib] = useState<number | null>(null);
  const [scripts, setScripts] = useState<RepoFileEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ libName: string; file: RepoFile } | null>(null);

  const loadLibs = useCallback(() => {
    api.scripts()
      .then((r) => {
        setLibs(r);
        setCurLib((prev) => prev ?? r.find((l) => l.exists)?.id ?? r[0]?.id ?? null);
      })
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  const loadScripts = useCallback((libId: number) => {
    setLoading(true);
    setError('');
    api.repoFiles(libId, '', 'scripts')
      .then((r) => setScripts(r.entries))
      .catch((e) => { setError(String((e as Error).message)); setScripts(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadLibs(); }, [loadLibs]);
  useEffect(() => { if (curLib !== null) loadScripts(curLib); }, [curLib, loadScripts]);

  const openFile = async (f: RepoFileEntry) => {
    if (curLib === null) return;
    try {
      const file = await api.repoFile(curLib, f.name, 'scripts');
      setDetail({ libName: libs.find((l) => l.id === curLib)?.name ?? '', file });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const removeFile = async (f: RepoFileEntry) => {
    if (curLib === null) return;
    if (!window.confirm(`确认删除脚本文件 ${f.name}？`)) return;
    try {
      await api.deleteScriptFile(curLib, f.name);
      loadScripts(curLib);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const filtered = (scripts ?? []).filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  const curName = curLib !== null ? libs.find((l) => l.id === curLib)?.name ?? '' : '';

  return (
    <>
      <div className="page-title">自动化脚本</div>
      <div className="page-desc">用例转自动化脚本（hypium 风格 TS）落盘于工作区 scripts 目录 · 可查看 / 删除，重新生成时覆盖同名文件</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div className="grid" style={{ gridTemplateColumns: '230px 1fr' }}>
        <div className="card" style={{ padding: 12 }}>
          <div className="card-h" style={{ marginBottom: 8 }}>
            <span className="t">三方库列表</span>
            <span className="sub">{libs.filter((l) => l.exists).length} 个有脚本</span>
          </div>
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {libs.map((l) => (
              <div
                key={l.id}
                className={`nav-item ${curLib === l.id ? 'active' : ''}`}
                style={{ margin: 0, borderRadius: 7 }}
                onClick={() => setCurLib(l.id)}
              >
                <span className="ico">📦</span>
                {l.name}
                <span className="badge">{l.fileCount}</span>
              </div>
            ))}
            {libs.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 10 }}>暂无三方库</div>}
          </div>
        </div>

        <div className="card" style={{ padding: '12px 0 6px' }}>
          <div style={{ padding: '0 14px', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="search-wrap" style={{ maxWidth: 260 }}>
              <span className="ic">🔍</span>
              <input className="input" placeholder="搜索脚本文件…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
              {curName} · {filtered.length} 个脚本
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div className="loading">加载中…</div>
            ) : !scripts || scripts.length === 0 ? (
              <div className="loading">该库暂无脚本，先在任务页用「用例转自动化脚本」生成</div>
            ) : filtered.length === 0 ? (
              <div className="loading">无匹配脚本</div>
            ) : (
              <table>
                <tr><th>文件</th><th>大小</th><th>修改时间</th><th>操作</th></tr>
                {filtered.map((s) => (
                  <tr key={s.name}>
                    <td className="mono">{s.name}</td>
                    <td className="muted">{fmtSize(s.size)}</td>
                    <td className="muted">{new Date(s.mtime).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>
                      <span className="link" onClick={() => void openFile(s)}>查看</span>
                      <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                      <span className="link" style={{ color: 'var(--red)' }} onClick={() => void removeFile(s)}>删除</span>
                    </td>
                  </tr>
                ))}
              </table>
            )}
          </div>
        </div>
      </div>

      {detail && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setDetail(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 820, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{detail.libName} · {detail.file.name}</span>
              {detail.file.truncated && <span className="tag amber">已截断（&gt;256KB 仅预览头部）</span>}
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setDetail(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
              {detail.file.binary ? (
                <div className="loading">二进制文件，无法预览</div>
              ) : (
                <pre className="mono" style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre', overflowX: 'auto' }}>{detail.file.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
