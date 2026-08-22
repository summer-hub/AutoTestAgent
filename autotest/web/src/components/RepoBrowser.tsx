import { useCallback, useEffect, useState } from 'react';
import type { RepoFile, RepoFileEntry, RepoInfo } from 'shared';
import { api } from '../api';

interface RepoBrowserProps {
  mode: 'input' | 'browse';
  taskType?: 'pull_repo' | 'update_repo';
  targetLibId?: number;
  onClose: () => void;
  onCreated: (info: { type: 'pull_repo' | 'update_repo'; url: string; title: string }) => Promise<void>;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** 拉取仓库 URL 输入弹窗 + 仓库本地目录浏览器（服务器工作区 repos/） */
export default function RepoBrowser({ mode, taskType, targetLibId, onClose, onCreated }: RepoBrowserProps) {
  const [url, setUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [cur, setCur] = useState<RepoInfo | null>(null);
  const [relPath, setRelPath] = useState('');
  const [entries, setEntries] = useState<RepoFileEntry[] | null>(null);
  const [file, setFile] = useState<RepoFile | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFiles = useCallback(async (repo: RepoInfo, rel: string) => {
    setBusy(true); setErr(''); setFile(null);
    try {
      const r = await api.repoFiles(repo.id, rel);
      setRelPath(r.path);
      setEntries(r.entries);
    } catch (e) {
      setErr((e as Error).message);
      setEntries(null);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    if (mode !== 'browse') return;
    api.repos()
      .then((rs) => {
        setRepos(rs);
        if (targetLibId) {
          const hit = rs.find((r) => r.id === targetLibId);
          if (hit) { setCur(hit); void loadFiles(hit, ''); }
        }
      })
      .catch((e) => setErr((e as Error).message));
  }, [mode, targetLibId, loadFiles]);

  const openEntry = (e: RepoFileEntry) => {
    if (!cur) return;
    const rel = relPath ? `${relPath}/${e.name}` : e.name;
    if (e.type === 'dir') {
      void loadFiles(cur, rel);
    } else {
      setBusy(true); setErr(''); setFile(null);
      api.repoFile(cur.id, rel)
        .then(setFile)
        .catch((x) => setErr((x as Error).message))
        .finally(() => setBusy(false));
    }
  };

  const submit = async () => {
    if (!taskType) return;
    const u = url.trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(u)) {
      setErr('请输入有效的仓库地址（http/https/git/ssh URL）');
      return;
    }
    setCreating(true);
    setErr('');
    try {
      await onCreated({ type: taskType, url: u, title: taskType === 'pull_repo' ? '拉取仓库代码' : '更新仓库代码' });
    } catch (e) {
      setErr((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <div className="s-overlay show">
      <div className="s-mask" onClick={onClose} />
      <div style={{
        position: 'relative', zIndex: 1, width: 920, maxWidth: 'calc(100vw - 48px)',
        height: mode === 'input' ? undefined : 640, maxHeight: 'calc(100vh - 48px)',
        background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16,
        boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>
            {mode === 'input' ? (taskType === 'update_repo' ? '🔄 更新仓库代码' : '📦 拉取仓库代码') : '📁 仓库本地目录'}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {mode === 'input' ? '输入仓库地址，系统将 clone/pull 到服务器工作区' : '服务器工作区 repos/ 下的三方库代码'}
          </span>
          <div style={{ flex: 1 }} />
          <button className="s-header x" onClick={onClose} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>

        {mode === 'input' ? (
          <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label className="muted" style={{ fontSize: 12.5 }}>仓库地址（支持 https / git / ssh）</label>
            <input
              className="input mono" autoFocus
              placeholder="https://github.com/summer-hub/AutoTestAgent.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
            {err && <div className="error" style={{ marginBottom: 0 }}>⚠️ {err}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn primary" disabled={creating} onClick={() => void submit()}>
                {creating ? '创建任务中…' : '开始拉取'}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
              任务创建后自动执行：克隆到 <span className="mono">app.workspace/repos/&lt;库名&gt;</span>，记录版本与变更文件；完成后可在「查看目录」中浏览代码。
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ width: 280, flex: 'none', borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 10 }}>
              <div className="muted" style={{ fontSize: 11, padding: '6px 8px' }}>已配置仓库地址的三方库（{repos?.length ?? '…'}）</div>
              {repos?.map((r) => (
                <div
                  key={r.id}
                  onClick={() => { setCur(r); void loadFiles(r, ''); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8,
                    cursor: 'pointer', background: cur?.id === r.id ? 'var(--accent-dim)' : 'transparent',
                    color: cur?.id === r.id ? 'var(--accent2)' : 'var(--text2)', fontSize: 12.5,
                  }}
                >
                  <span>📦</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span className={`tag ${r.exists ? 'green' : 'gray'}`} style={{ fontSize: 10 }}>{r.exists ? '已拉取' : '未拉取'}</span>
                </div>
              ))}
              {repos && repos.length === 0 && (
                <div className="muted" style={{ fontSize: 12, padding: 10 }}>暂无仓库，先在任务页「拉取仓库代码」输入地址拉取。</div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                {cur ? (
                  <>
                    <span className="mono" style={{ color: 'var(--accent2)' }}>{cur.name}</span>
                    <span className="muted">/</span>
                    {relPath.split('/').map((seg, i, arr) => (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {i > 0 && <span className="muted">/</span>}
                        <span className="link" onClick={() => void loadFiles(cur, arr.slice(0, i + 1).join('/'))}>{seg || 'root'}</span>
                      </span>
                    ))}
                    <span className="muted" style={{ marginLeft: 'auto', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur.dir}</span>
                  </>
                ) : (
                  <span>选择左侧仓库查看本地目录</span>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
                {err && <div className="error" style={{ margin: 8 }}>⚠️ {err}</div>}
                {busy && <div className="loading">加载中…</div>}
                {!busy && file && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
                      <span className="mono" style={{ fontSize: 12.5 }}>📄 {file.name}</span>
                      {file.truncated && <span className="tag amber">已截断（&gt;256KB 仅预览头部）</span>}
                      <div style={{ flex: 1 }} />
                      <span className="link" onClick={() => setFile(null)}>← 返回目录</span>
                    </div>
                    {file.binary ? (
                      <div className="loading">二进制文件，无法预览</div>
                    ) : (
                      <pre className="mono" style={{ fontSize: 12, lineHeight: 1.55, padding: 14, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, whiteSpace: 'pre', maxHeight: '46vh', overflowY: 'auto' }}>{file.content}</pre>
                    )}
                  </div>
                )}
                {!busy && !file && entries && (
                  <table>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.name} onClick={() => openEntry(e)} style={{ cursor: 'pointer' }}>
                          <td style={{ width: 30 }}>{e.type === 'dir' ? '📁' : '📄'}</td>
                          <td className="mono">{e.name}</td>
                          <td style={{ width: 90, textAlign: 'right' }} className="muted">{e.type === 'dir' ? '—' : fmtSize(e.size)}</td>
                          <td style={{ width: 150, textAlign: 'right' }} className="muted">{new Date(e.mtime).toLocaleString('zh-CN', { hour12: false })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
