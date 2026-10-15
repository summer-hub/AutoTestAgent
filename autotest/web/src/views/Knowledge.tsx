import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 知识库（P9 · LLM wiki）：人工确认过的结论沉淀成条目，下次同类任务自动注入。
 *
 * 页面刻意把"检索预览"放在显眼位置：注入不是黑盒 —— 每个阶段会注入哪些条目、
 * 为什么命中、置信度多少，都能在这里逐条看到。这是选 wiki 而不是向量库的直接好处。
 */
interface Entry {
  id: string; scopeKind: string; scopeKey: string; kind: string; title: string;
  keywords: string[]; status: string; confidence: number; evidence: Array<Record<string, unknown>>;
  body: string; createdAt: string; updatedAt: string; wikiPath: string;
}

const SCOPE_LABEL: Record<string, string> = { library: '库级', api: '接口级', control: '控件级', scenario: '场景级', global: '全局' };
const KIND_LABEL: Record<string, string> = {
  traversal_quirk: '遍历怪癖', oracle_recipe: '判据配方', special_handling: '特殊处置',
  blocked_reason: '阻塞原因', demo_patch: 'demo 补丁', human_verdict: '人工结论',
};
const STATUS_META: Record<string, [string, string]> = {
  ai_draft: ['AI 草稿', 'amber'], human_confirmed: ['人工已确认', 'green'], rejected: ['已否决', 'gray'], deprecated: ['已过时', 'gray'],
};

export default function KnowledgePage() {
  const [data, setData] = useState<{ total: number; broken: string[]; byStatus: Record<string, number>; byKind: Record<string, number>; wikiRoot: string; entries: Entry[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [scopeKind, setScopeKind] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<Entry | null>(null);
  const [probe, setProbe] = useState<{ library: string; apiName: string; scenarioKind: string }>({ library: '', apiName: '', scenarioKind: '' });
  const [probeResult, setProbeResult] = useState<Awaited<ReturnType<typeof api.knowledgeRetrieve>> | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    api.knowledge({ scopeKind: scopeKind || undefined, status: status || undefined, q: q || undefined })
      .then(setData)
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(false));
  }, [scopeKind, status, q]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true); setError(''); setMsg('');
    try { await fn(); setMsg(okText); load(); setDetail(null); }
    catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const runProbe = async () => {
    setError(''); setMsg('');
    try {
      const r = await api.knowledgeRetrieve({
        library: probe.library || undefined, apiName: probe.apiName || undefined,
        scenarioKind: probe.scenarioKind || undefined, budgetChars: 1500,
      });
      setProbeResult(r);
    } catch (e) { setError(String((e as Error).message)); }
  };

  const rows = data?.entries ?? [];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>知识库</div>
          <div className="page-desc">
            LLM wiki（无向量）：作用域键 + 关键词检索，命中有理由 · 共 {data?.total ?? 0} 条
            {data && `${data.byStatus.human_confirmed ? ` · 已确认 ${data.byStatus.human_confirmed}` : ''}${data.byStatus.ai_draft ? ` · 待确认 ${data.byStatus.ai_draft}` : ''}`}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={busy} onClick={() => void act(() => api.knowledgeRebuild(), '索引已由 md 重建（md 是唯一事实来源）')}>重建索引</button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}
      {data && data.broken.length > 0 && (
        <div className="error">有 {data.broken.length} 个 md 文件解析失败（已跳过，不影响其余）：{data.broken.slice(0, 3).join('、')}</div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>检索预览（注入不是黑盒）</b>
        <div className="muted" style={{ fontSize: 11.8, margin: '4px 0 8px' }}>
          填一个查询，看会注入哪些条目、为什么命中、置信度多少。数据来源：<span className="mono">{data?.wikiRoot ?? ''}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 160 }} placeholder="库名" value={probe.library} onChange={(e) => setProbe({ ...probe, library: e.target.value })} />
          <input className="input" style={{ width: 200 }} placeholder="接口名（如 demo-lib:Validator）" value={probe.apiName} onChange={(e) => setProbe({ ...probe, apiName: e.target.value })} />
          <input className="input" style={{ width: 140 }} placeholder="场景（如 bigdata）" value={probe.scenarioKind} onChange={(e) => setProbe({ ...probe, scenarioKind: e.target.value })} />
          <button className="btn primary" onClick={() => void runProbe()}>试检索</button>
        </div>
        {probeResult && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 11.8, marginBottom: 4 }}>
              命中 {probeResult.selected.length} 条{probeResult.truncated > 0 ? ` · 因预算截断 ${probeResult.truncated} 条` : ''}
            </div>
            {probeResult.why.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>没有命中任何条目（不硬塞：宁可注入为空，也不塞不相关经验）</div>
            ) : probeResult.why.map((w) => (
              <div key={w.id} className="mono" style={{ fontSize: 11.5 }}>
                [{w.score}] {w.title} — <span className="muted">{w.why}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <div className="search-wrap">
            <span className="ic">🔍</span>
            <input className="input" placeholder="搜索标题 / 关键词 / 作用域键" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="input" style={{ width: 130 }} value={scopeKind} onChange={(e) => setScopeKind(e.target.value)}>
            <option value="">全部作用域</option>
            {Object.entries(SCOPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="input" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="loading">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="loading">
            还没有知识条目。人工队列里的结论会自动沉淀到这里（AI 草稿），
            你也可以在条目上点「确认」把它变成可跨任务复用的经验（**没有证据的条目不允许确认**）。
          </div>
        ) : (
          <table>
            <thead>
              <tr><th style={{ width: 100 }}>作用域</th><th style={{ width: 110 }}>类型</th><th>标题</th><th style={{ width: 90 }}>状态</th><th style={{ width: 70 }}>置信</th><th style={{ width: 150 }}>操作</th></tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const [sl, sc] = STATUS_META[e.status] ?? [e.status, 'gray'];
                return (
                  <tr key={e.id}>
                    <td><span className="tag gray">{SCOPE_LABEL[e.scopeKind] ?? e.scopeKind}</span><div className="muted mono" style={{ fontSize: 10.5 }}>{e.scopeKey || '—'}</div></td>
                    <td><span className="tag blue">{KIND_LABEL[e.kind] ?? e.kind}</span></td>
                    <td>
                      <span className="link" onClick={() => setDetail(e)}>{e.title}</span>
                      <div className="muted" style={{ fontSize: 10.5 }}>{e.keywords.slice(0, 6).join(' · ')}</div>
                    </td>
                    <td><span className={`tag ${sc}`}>{sl}</span></td>
                    <td>{e.confidence}</td>
                    <td>
                      {e.status !== 'human_confirmed' && (
                        <span className="link" title={e.evidence.length ? '确认为可复用经验' : '没有证据的条目不允许确认'} onClick={() => void act(() => api.knowledgeConfirm(e.id), `已确认：${e.title}`)}>确认</span>
                      )}
                      {e.status !== 'rejected' && <>{' · '}<span className="link" onClick={() => void act(() => api.knowledgeStatus(e.id, 'rejected'), '已否决（不再参与注入）')}>否决</span></>}
                      {e.status !== 'deprecated' && <>{' · '}<span className="link" onClick={() => void act(() => api.knowledgeStatus(e.id, 'deprecated'), '已标记过时')}>过时</span></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <div className="drawer-mask show" onClick={(ev) => { if (ev.target === ev.currentTarget) setDetail(null); }}>
          <div className="drawer" style={{ maxWidth: 780 }}>
            <div className="drawer-h">
              <b>{detail.title}</b>
              <span className="x" onClick={() => setDetail(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 8 }}>
                {detail.id} · {detail.wikiPath} · {SCOPE_LABEL[detail.scopeKind]}/{detail.scopeKey} · {KIND_LABEL[detail.kind]} · 置信度 {detail.confidence}
              </div>
              <div style={{ marginBottom: 8 }}>
                <b style={{ fontSize: 12 }}>证据（{detail.evidence.length}）</b>
                <div className="mono muted" style={{ fontSize: 11.5 }}>{detail.evidence.map((v) => JSON.stringify(v)).join('\n') || '（无：无证据不允许确认）'}</div>
              </div>
              <pre className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--panel3)', padding: 10, borderRadius: 8 }}>{detail.body}</pre>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                正文在 <span className="mono">{detail.wikiPath}</span>，可直接用编辑器改；改完点「重建索引」即可生效（md 是唯一事实来源，DB 只是索引）。
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
