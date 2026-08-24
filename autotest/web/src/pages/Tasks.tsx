import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task, TaskType } from 'shared';
import { api } from '../api';
import RepoBrowser from '../components/RepoBrowser';

const PRESETS: Array<{ type: TaskType; icon: string; title: string; desc: string }> = [
  { type: 'pull_repo', icon: '📦', title: '拉取仓库代码', desc: '拉取三方库最新代码' },
  { type: 'update_repo', icon: '🔄', title: '更新仓库代码', desc: '同步到指定版本' },
  { type: 'write_cases', icon: '✍️', title: '编写测试用例', desc: '代码+规则生成用例' },
  { type: 'update_cases', icon: '♻️', title: '更新测试用例', desc: '版本迭代 V→V+1' },
  { type: 'to_script', icon: '🤖', title: '用例转自动化脚本', desc: '用例库→可执行脚本' },
];

const STATUS_TAG: Record<string, string> = { pending: 'gray', running: 'blue', done: 'green', failed: 'red', stopped: 'gray' };

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [repoDialog, setRepoDialog] = useState<null | { mode: 'input'; type: 'pull_repo' | 'update_repo' } | { mode: 'browse'; libId?: number; tab?: 'repos' | 'scripts' }>(null);
  const [libTask, setLibTask] = useState<null | { type: 'write_cases' | 'update_cases' | 'to_script' }>(null);
  const [libs, setLibs] = useState<Array<{ id: number; name: string; caseCount?: number }>>([]);
  const [libSel, setLibSel] = useState<number | ''>('');
  const [libPrompt, setLibPrompt] = useState('');
  const [libSaving, setLibSaving] = useState(false);
  const [traceView, setTraceView] = useState<Task | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api.tasks().then(setTasks).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => {
    load();
    api.libraries({ pageSize: 200 }).then((r) => setLibs(r.items)).catch(() => {});
    pollRef.current = setInterval(load, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const submit = async (type: TaskType, title: string, text?: string) => {
    setError('');
    try {
      await api.createTask({ type, input: text || undefined, title });
      setInput('');
      load();
    } catch (e) { setError((e as Error).message); }
  };

  const submitRepoUrl = async (info: { type: 'pull_repo' | 'update_repo'; url: string; title: string }) => {
    await api.createTask({ type: info.type, input: info.url, title: info.title });
    setRepoDialog(null);
    load();
  };

  const onPreset = (p: { type: TaskType; title: string }) => {
    if (p.type === 'pull_repo' || p.type === 'update_repo') {
      setRepoDialog({ mode: 'input', type: p.type });
    } else if (p.type === 'write_cases' || p.type === 'update_cases' || p.type === 'to_script') {
      setLibTask({ type: p.type });
      setLibSel('');
      setLibPrompt('');
    } else {
      void submit(p.type, p.title, input);
    }
  };

  const retry = async (id: number) => {
    try { await api.retryTask(id); load(); } catch (e) { setError((e as Error).message); }
  };

  const removeTask = async (t: Task) => {
    if (!window.confirm(`确认删除任务 ${t.taskNo}（${t.title}）？`)) return;
    try { await api.deleteTask(t.id); load(); } catch (e) { setError((e as Error).message); }
  };

  const submitLibTask = async () => {
    if (!libTask || libSel === '') { setError('请选择三方库'); return; }
    setLibSaving(true);
    setError('');
    try {
      const titles: Record<string, string> = { write_cases: '编写测试用例', update_cases: '更新测试用例', to_script: '用例转自动化脚本' };
      await api.createTask({ type: libTask.type, libraryId: libSel, input: libPrompt.trim() || undefined, title: titles[libTask.type] });
      setLibTask(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLibSaving(false);
    }
  };

  return (
    <>
      <div className="page-title">任务管理</div>
      <div className="page-desc">给 AI 配置任务：支持自然语言对话输入，或通过预置卡片快速创建（真实调用大模型）</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div className="card" style={{ marginBottom: 14, padding: '14px 16px 12px' }}>
        <textarea
          className="input"
          style={{ width: '100%', minHeight: 52, resize: 'none', background: 'transparent', border: 'none', outline: 'none', fontSize: 13.5, lineHeight: 1.6 }}
          placeholder="输入任务描述，例如：为 charts-ohos 库编写柱状图边界场景测试用例…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {PRESETS.map((p) => (
            <button key={p.type} className="btn sm" title={p.desc} onClick={() => onPreset(p)}>
              {p.icon} {p.title}
            </button>
          ))}
          <button className="btn sm" title="查看服务器工作区已拉取的仓库本地目录" onClick={() => setRepoDialog({ mode: 'browse' })}>
            📁 仓库目录
          </button>
          <button className="btn sm" title="查看用例转自动化脚本的落盘目录" onClick={() => setRepoDialog({ mode: 'browse', tab: 'scripts' })}>
            🤖 脚本目录
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => submit('write_cases', '编写测试用例', input)}>发送 ▶</button>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <span className="t">任务列表</span>
          <span className="sub">3 秒自动刷新 · AI 任务真实执行</span>
        </div>
        {tasks.length === 0 ? (
          <div className="loading">暂无任务，使用上方输入框或预置卡片创建</div>
        ) : (
          tasks.map((t) => (
            <div key={t.id} className="task-row" style={{ display: 'flex', gap: 12, padding: '11px 4px', borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
              <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {PRESETS.find((p) => p.type === t.type)?.icon ?? '🤖'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 550 }}>
                  {t.title} <span className="mono muted" style={{ fontSize: 11 }}>{t.taskNo}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 3 }}>
                  {t.createdAt} · {t.input || '（无补充描述）'}
                </div>
                {t.resultSummary && (
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 5, lineHeight: 1.6 }}>{t.resultSummary}</div>
                )}
                {t.error && (
                  <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 5, lineHeight: 1.6 }}>✗ {t.error}</div>
                )}
                <div className="progress" style={{ height: 5, background: 'var(--panel3)', borderRadius: 4, marginTop: 8, overflow: 'hidden' }}>
                  <i style={{ display: 'block', height: '100%', width: `${t.progress}%`, background: t.status === 'failed' ? 'var(--red)' : 'var(--accent)', borderRadius: 4 }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <span className={`tag ${STATUS_TAG[t.status] ?? 'gray'}`}>{t.status === 'running' ? `运行中 ${t.progress}%` : t.status}</span>
                {(t.type === 'pull_repo' || t.type === 'update_repo') && t.status === 'done' && t.libraryId && (
                  <span className="link" style={{ fontSize: 12 }} onClick={() => setRepoDialog({ mode: 'browse', libId: t.libraryId ?? undefined })}>查看目录</span>
                )}
                {t.type === 'to_script' && t.status === 'done' && t.libraryId && (
                  <span className="link" style={{ fontSize: 12 }} onClick={() => setRepoDialog({ mode: 'browse', libId: t.libraryId ?? undefined, tab: 'scripts' })}>查看脚本</span>
                )}
                {(t.trace?.length ?? 0) > 0 && (
                  <span className="link" style={{ fontSize: 12 }} onClick={() => setTraceView(t)}>查看轨迹</span>
                )}
                {t.status === 'failed' && <button className="btn sm" onClick={() => retry(t.id)}>重试</button>}
                <span className="link" style={{ fontSize: 12, color: 'var(--red)' }} onClick={() => void removeTask(t)}>删除</span>
              </div>
            </div>
          ))
        )}
      </div>

      {traceView && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setTraceView(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 760, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>🤖 {traceView.taskNo} · {traceView.title} 执行轨迹</span>
              <span className={`tag ${traceView.status === 'done' ? 'green' : traceView.status === 'failed' ? 'red' : 'blue'}`}>{traceView.status}</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setTraceView(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {traceView.trace && traceView.trace.length > 0 ? traceView.trace.map((e) => (
                <div key={e.seq} style={{ display: 'flex', gap: 10 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>{e.seq}</span>
                    {e.seq < (traceView.trace?.length ?? 0) && <span style={{ width: 2, flex: 1, background: 'var(--border2)' }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>
                      <b style={{ color: 'var(--text)' }}>{e.title}</b>
                      <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{e.at}</span>
                    </div>
                    {e.detail && (
                      <pre className="mono" style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', maxHeight: 160, overflowY: 'auto', color: 'var(--text2)' }}>{e.detail}</pre>
                    )}
                  </div>
                </div>
              )) : <div className="muted" style={{ fontSize: 12.5 }}>该任务暂无轨迹记录</div>}
            </div>
          </div>
        </div>
      )}

      {libTask && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setLibTask(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 620, maxWidth: 'calc(100vw - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>
                {libTask.type === 'write_cases' ? '✍️ 编写测试用例' : libTask.type === 'update_cases' ? '♻️ 更新测试用例' : '🤖 用例转自动化脚本'}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>选择三方库并给 Agent 预置提示词</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setLibTask(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="muted" style={{ fontSize: 12 }}>三方库 *</span>
                <select className="select" value={libSel} onChange={(e) => setLibSel(e.target.value === '' ? '' : Number(e.target.value))}>
                  <option value="">请选择三方库…</option>
                  {libs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.caseCount ? `（${l.caseCount} 用例）` : ''}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="muted" style={{ fontSize: 12 }}>给 Agent 的提示词（可空）</span>
                <textarea
                  className="input"
                  style={{ minHeight: 90, resize: 'vertical', lineHeight: 1.6 }}
                  placeholder={libTask.type === 'write_cases' ? '如：基于真实界面设计用例，覆盖动画播放/暂停/进度控制，预期写明具体动画与日志' : '如：根据最新版本变更更新用例，版本自动递增'}
                  value={libPrompt}
                  onChange={(e) => setLibPrompt(e.target.value)}
                />
              </label>
              {error && <div className="error" style={{ marginBottom: 0 }}>⚠️ {error}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn" onClick={() => setLibTask(null)}>取消</button>
                <button className="btn primary" disabled={libSaving || libSel === ''} onClick={() => void submitLibTask()}>
                  {libSaving ? '创建任务中…' : '创建任务'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {repoDialog && (
        <RepoBrowser
          mode={repoDialog.mode}
          taskType={repoDialog.mode === 'input' ? repoDialog.type : undefined}
          targetLibId={repoDialog.mode === 'browse' ? repoDialog.libId : undefined}
          initialTab={repoDialog.mode === 'browse' ? repoDialog.tab : undefined}
          onClose={() => setRepoDialog(null)}
          onCreated={submitRepoUrl}
        />
      )}
    </>
  );
}
