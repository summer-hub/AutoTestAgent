import { useCallback, useEffect, useState } from 'react';
import type { Library } from 'shared';
import { api } from '../api';

/**
 * Agent 绑定（P10）：把"用哪个 agent 实现某个阶段"变成可切换、可追溯的配置。
 *
 * 页面结构刻意按「阶段即接口」来排：每个阶段一行，显示它的输入输出约定（这是与 agent 实现解耦的契约）、
 * 当前生效的实现（内置 / 自写 Prompt / 自写 Skill / 外部命令）与来源（按库 > 全局 > 内置默认）。
 * 切换即生效（下一个任务），历史任务的轨迹里记录了当时用的是哪个绑定。
 */
interface Binding {
  stage: string; kind: string; source: string; scope: string; libraryId: number | null;
  promptId: number | null; skillPath: string; model: string; params: Record<string, unknown>; externalCmd: string;
  def: { stage: string; label: string; builtinRole: string; input: string; output: string; knowledgeKinds: string[]; knowledgeBudget: number };
  raw: Record<string, unknown> | null;
}

const KIND_LABEL: Record<string, string> = { builtin: '内置 Agent', prompt: '自写 Prompt', skill: '自写 Skill', external: '外部 Agent' };
const KIND_COLOR: Record<string, string> = { builtin: 'gray', prompt: 'blue', skill: 'purple', external: 'amber' };

export default function AgentBindingsPage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libraryId, setLibraryId] = useState<number | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [prompts, setPrompts] = useState<Array<{ id: number; name: string; role: string }>>([]);
  const [edit, setEdit] = useState<null | { stage: string; label: string; kind: string; scope: 'global' | 'library'; promptId: string; skillPath: string; model: string; externalCmd: string; temperature: string }>(null);

  useEffect(() => {
    api.libraries({ pageSize: 300 }).then((r) => setLibs(r.items)).catch(() => {});
    api.prompts().then((r) => setPrompts(r.map((p) => ({ id: p.id, name: p.name, role: p.role })))).catch(() => {});
  }, []);

  const load = useCallback((libId: number | null) => {
    setLoading(true); setError('');
    api.agentBindings(libId ?? undefined)
      .then((r) => setBindings(r.bindings))
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(libraryId); }, [libraryId, load]);

  const save = async () => {
    if (!edit) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const params: Record<string, unknown> = {};
      if (edit.temperature.trim()) params.temperature = Number(edit.temperature);
      await api.upsertAgentBinding({
        stage: edit.stage, scope: edit.scope, libraryId: edit.scope === 'library' ? libraryId ?? undefined : undefined,
        kind: edit.kind as 'builtin' | 'prompt' | 'skill' | 'external',
        promptId: edit.promptId ? Number(edit.promptId) : undefined,
        skillPath: edit.skillPath, model: edit.model, externalCmd: edit.externalCmd, params,
      });
      setMsg(`已更新绑定：${edit.stage} → ${KIND_LABEL[edit.kind]}（下一个任务即生效）`);
      setEdit(null);
      load(libraryId);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const checkExternal = async (cmd: string) => {
    setError(''); setMsg('');
    try {
      const r = await api.externalCmdCheck(cmd);
      setMsg(r.available ? `命令可用：${r.reason}` : `⚠️ ${r.reason}`);
    } catch (e) { setError(String((e as Error).message)); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>Agent 绑定</div>
          <div className="page-desc">
            阶段即接口：每个阶段的输入输出是固定约定，用哪个 agent 实现可随时切换 · 切换即生效，历史任务可追溯到当时的绑定
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ width: 220 }} value={libraryId ?? ''} onChange={(e) => setLibraryId(e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">（不按库，只看全局）</option>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="muted" style={{ fontSize: 11.8, marginBottom: 8 }}>
          优先级：<b>按库绑定</b> &gt; <b>全局绑定</b> &gt; <b>内置默认</b>。所以最省事的用法是"默认全用内置，个别库换自写 agent"。
        </div>
        {loading ? (
          <div className="loading">加载中…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 170 }}>阶段</th>
                <th style={{ width: 150 }}>输入 → 输出</th>
                <th style={{ width: 170 }}>当前生效</th>
                <th>来源 / 参数</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((b) => (
                <tr key={b.stage}>
                  <td>
                    <b style={{ fontSize: 12.5 }}>{b.def.label}</b>
                    <div className="muted mono" style={{ fontSize: 10.5 }}>{b.stage} · 内置 role：{b.def.builtinRole}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{b.def.input}<br />→ <span className="mono">{b.def.output}</span></td>
                  <td>
                    <span className={`tag ${KIND_COLOR[b.kind] ?? 'gray'}`}>{KIND_LABEL[b.kind] ?? b.kind}</span>
                    {b.def.knowledgeBudget > 0 && (
                      <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>知识注入预算 {b.def.knowledgeBudget} 字</div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {b.source}
                    {b.promptId ? <div className="mono">prompt #{b.promptId}</div> : null}
                    {b.skillPath ? <div className="mono">skill {b.skillPath}</div> : null}
                    {b.model ? <div className="mono">model {b.model}</div> : null}
                    {b.externalCmd ? <div className="mono">cmd {b.externalCmd}</div> : null}
                    {Object.keys(b.params).length > 0 ? <div className="mono">params {JSON.stringify(b.params)}</div> : null}
                  </td>
                  <td>
                    <span className="link" onClick={() => setEdit({
                      stage: b.stage, label: b.def.label, kind: b.kind, scope: b.scope === 'library' ? 'library' : 'global',
                      promptId: b.promptId ? String(b.promptId) : '', skillPath: b.skillPath, model: b.model,
                      externalCmd: b.externalCmd, temperature: String((b.params.temperature as number | undefined) ?? ''),
                    })}>切换</span>
                    {b.raw && (
                      <>
                        {' · '}
                        <span className="link" style={{ color: 'var(--red)' }} onClick={() => void (async () => {
                          try { await api.deleteAgentBinding(Number(b.raw?.id)); setMsg('已删除绑定，回到上一级默认'); load(libraryId); }
                          catch (e) { setError(String((e as Error).message)); }
                        })()}>恢复默认</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {edit && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setEdit(null); }}>
          <div className="drawer" style={{ maxWidth: 620 }}>
            <div className="drawer-h">
              <b>切换 Agent · {edit.label}（{edit.stage}）</b>
              <span className="x" onClick={() => setEdit(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>作用范围</span>
                <select className="input" value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value as 'global' | 'library' })}>
                  <option value="global">全局（所有库默认）</option>
                  <option value="library" disabled={libraryId === null}>按库（{libraryId === null ? '请先在上方选择库' : `库 #${libraryId}`}）</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>实现方式</span>
                <select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                  <option value="builtin">内置 Agent（内置 prompt）</option>
                  <option value="prompt">自写 Prompt（从 Prompt 管理里选）</option>
                  <option value="skill">自写 Skill（skills/ 下的 SKILL.md）</option>
                  <option value="external">外部 Agent（命令行 / MCP）</option>
                </select>
              </label>
              {edit.kind === 'prompt' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Prompt 模板</span>
                  <select className="input" value={edit.promptId} onChange={(e) => setEdit({ ...edit, promptId: e.target.value })}>
                    <option value="">请选择…</option>
                    {prompts.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.role}）</option>)}
                  </select>
                </label>
              )}
              {edit.kind === 'skill' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Skill 路径（SKILL.md）</span>
                  <input className="input mono" value={edit.skillPath} placeholder="skills/my-stage/SKILL.md" onChange={(e) => setEdit({ ...edit, skillPath: e.target.value })} />
                </label>
              )}
              {edit.kind === 'external' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                  <span className="muted" style={{ fontSize: 12 }}>外部命令</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input mono" style={{ flex: 1 }} value={edit.externalCmd} placeholder="devecocli …" onChange={(e) => setEdit({ ...edit, externalCmd: e.target.value })} />
                    <button className="btn" onClick={() => void checkExternal(edit.externalCmd)}>检测</button>
                  </div>
                  <span className="muted" style={{ fontSize: 11 }}>
                    外部 agent 按本阶段的输入输出约定接入（见上方「输入 → 输出」列）；平台会把同一份输入交给它，并对输出做 Schema 校验。
                  </span>
                </label>
              )}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>模型（留空=跟随默认）</span>
                <input className="input mono" value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
                <span className="muted" style={{ fontSize: 12 }}>温度（留空=默认）</span>
                <input className="input mono" value={edit.temperature} onChange={(e) => setEdit({ ...edit, temperature: e.target.value })} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" disabled={busy} onClick={() => void save()}>保存（下一个任务即生效）</button>
                <button className="btn" onClick={() => setEdit(null)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
