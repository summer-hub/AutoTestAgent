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
  const [repoDialog, setRepoDialog] = useState<null | { mode: 'input'; type: 'pull_repo' | 'update_repo' } | { mode: 'browse'; libId?: number }>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api.tasks().then(setTasks).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => {
    load();
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
    } else {
      void submit(p.type, p.title, input);
    }
  };

  const retry = async (id: number) => {
    try { await api.retryTask(id); load(); } catch (e) { setError((e as Error).message); }
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
                {t.status === 'failed' && <button className="btn sm" onClick={() => retry(t.id)}>重试</button>}
              </div>
            </div>
          ))
        )}
      </div>

      {repoDialog && (
        <RepoBrowser
          mode={repoDialog.mode}
          taskType={repoDialog.mode === 'input' ? repoDialog.type : undefined}
          targetLibId={repoDialog.mode === 'browse' ? repoDialog.libId : undefined}
          onClose={() => setRepoDialog(null)}
          onCreated={submitRepoUrl}
        />
      )}
    </>
  );
}
