import { useCallback, useEffect, useState } from 'react';
import type { Prompt } from 'shared';
import { api } from '../api';

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [form, setForm] = useState({ name: '', role: '', content: '' });

  const load = useCallback(() => {
    api.prompts().then(setPrompts).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEdit = (p: Prompt) => {
    setEditing(p);
    setForm({ name: p.name, role: p.role, content: p.content });
  };

  const save = async () => {
    setError('');
    try {
      if (editing) {
        await api.updatePrompt(editing.id, form);
      } else {
        await api.addPrompt(form);
      }
      setEditing(null);
      load();
    } catch (e) { setError((e as Error).message); }
  };

  const remove = async (p: Prompt) => {
    try { await api.deletePrompt(p.id); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <div className="page-title">Prompt 管理</div>
      <div className="page-desc">预设 Agent 的提示词模板 · 支持变量注入（{"{library}"} {"{version}"} 等）· 任务执行时按角色自动选用</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <button className="btn primary" onClick={() => { setEditing(null); setForm({ name: '', role: '', content: '' }); setEditing({ id: 0, name: '', role: '', content: '', variables: [], builtin: false, version: 0, updatedAt: '' }); }}>
          ＋ 新建模板
        </button>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12 }}>共 {prompts.length} 个模板</span>
      </div>

      <div className="grid grid-3">
        {prompts.map((p) => (
          <div key={p.id} className="card" style={{ cursor: 'pointer' }} onClick={() => openEdit(p)}>
            <div className="card-h">
              <span className="t">{p.name}</span>
              <span className={`tag ${p.builtin ? 'green' : 'blue'}`}>{p.builtin ? '内置' : '自定义'}</span>
              <span className="sub">v{p.version}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 96, overflow: 'hidden' }}>{p.content ?? ''}</div>
            <div style={{ marginTop: 10, fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="muted">角色：{p.role || '—'}</span>
              {(p.variables ?? []).map((v) => <span key={v} className="tag blue">{"{"}{v}{"}"}</span>)}
              <span style={{ flex: 1 }} />
              {!p.builtin && (
                <span className="link" style={{ color: 'var(--red)' }} onClick={(e) => { e.stopPropagation(); remove(p); }}>删除</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="drawer">
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>{editing.id ? '编辑模板' : '新建模板'}</span>
              <span className="x" onClick={() => setEditing(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">名称</div></div>
                <input className="input" style={{ flex: 1 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">角色（任务执行时按角色选用）</div></div>
                <input className="input" style={{ flex: 1 }} placeholder="用例生成 / 归因分析 / 任务编排 …" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
              </div>
              <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <div className="fl"><div className="ft">提示词模板</div></div>
                <textarea
                  className="input mono"
                  style={{ flex: 1, minHeight: 260, fontSize: 12, lineHeight: 1.7, resize: 'vertical' }}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setEditing(null)}>取消</button>
                <button className="btn primary" onClick={save}>保存（版本 +1）</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
