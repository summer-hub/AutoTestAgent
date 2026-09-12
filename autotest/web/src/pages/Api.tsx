import { Fragment, useCallback, useEffect, useState } from 'react';
import type { Library } from 'shared';
import { api } from '../api';

/**
 * 接口清单（P2）：把库对外暴露的符号变成可枚举、可定位、可核对的事实。
 *
 * 为什么单独一页而不是塞在库管理里：这一页的读者是"要判断覆盖够不够"的人，
 * 而库管理页的读者是"接入三方库"的人。更重要的是——这一页必须能回答
 * "哪些接口 demo 根本没用到"，因为那是后面自动生成用例的输入，
 * 也是唯一能证伪"覆盖率"的东西。
 *
 * 两类调用点严格分开显示：
 *   demo 调用点（src/main，真机可达）与单元测试调用点（src/ohosTest，Hypium）。
 * 单元测试跑通不代表真机上覆盖到了 —— 混在一起就是假覆盖。
 */
interface ApiSymbolRow {
  id: number; name: string; kind: string; signature: string;
  params: Array<{ name: string; type: string; optional: boolean; defaultValue: string; doc: string }>;
  returns: { type: string; doc: string };
  throws: Array<{ type: string; doc: string }>;
  deprecated: boolean; sourceFile: string; sourceLine: number; methods: string[];
  detailLevel: string;
  demoCallCount: number; testCallCount: number; pages: string[];
}

interface ApiPayload {
  libraryId: number; name: string; version: string;
  counts: { total: number; demoUsed: number; testOnly: number; unused: number };
  symbols: ApiSymbolRow[];
  demoAssets: Array<{ kind: string; name: string; pagePath: string; sourceFile: string; sourceLine: number; snippet: string; mutability: string }>;
}

const KIND_LABEL: Record<string, string> = {
  class: '类', function: '函数', interface: '接口', enum: '枚举', const: '常量', type: '类型', variable: '变量', unknown: '未识别',
};

const ASSET_TAG: Record<string, string> = {
  page: 'gray', control: 'gray', param: 'gray', call: 'green', test_call: 'blue',
};

export default function ApiPage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState<number>(0);
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState<'all' | 'used' | 'testOnly' | 'unused'>('all');
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    api.libraries({ pageSize: 300 }).then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId(r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
  }, []);

  const load = useCallback((id: number) => {
    if (!id) return;
    setLoading(true); setError('');
    api.apiSymbols(id)
      .then((r) => setData(r))
      .catch((e) => { setError(String((e as Error).message)); setData(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(libId); }, [libId, load]);

  const extract = async () => {
    if (!libId) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.extractApi(libId);
      setMsg(`已采集：入口 ${r.entryFile}（包名 ${r.packageName || '—'}）· 符号 ${r.symbols} · demo 调用点 ${r.callSites} · 单元测试调用点 ${r.testCallSites} · 问题 ${r.problems.length}`);
      load(libId);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const symbols = data?.symbols ?? [];
  const shown = symbols.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'used') return s.demoCallCount > 0;
    if (filter === 'testOnly') return s.demoCallCount === 0 && s.testCallCount > 0;
    return s.demoCallCount === 0 && s.testCallCount === 0;
  });
  const c = data?.counts;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>接口清单</div>
          <div className="page-desc">
            库对外暴露的符号 + demo 里的真实调用点 · 覆盖矩阵的分母
            {data?.version && <span className="muted"> · 采集版本 {data.version}</span>}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ width: 260 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !libId} onClick={() => void extract()}>
          {busy ? '采集中…' : '采集接口清单'}
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {c && (
        <div className="grid-3" style={{ marginTop: 12 }}>
          <div className="card">
            <div className="muted" style={{ fontSize: 12 }}>导出符号</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{c.total}</div>
          </div>
          <div className="card" style={{ borderColor: 'var(--green-dim)' }}>
            <div className="muted" style={{ fontSize: 12 }}>demo 真机调用了</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--green)' }}>{c.demoUsed}</div>
          </div>
          <div className="card" style={{ borderColor: 'var(--amber-dim)' }}>
            <div className="muted" style={{ fontSize: 12 }}>仅单元测试 / 完全没用到</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>
              <span style={{ color: 'var(--amber)' }}>{c.testOnly}</span>
              <span className="muted" style={{ fontSize: 14 }}> / </span>
              <span style={{ color: 'var(--red)' }}>{c.unused}</span>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {([['all', '全部'], ['used', 'demo 已调用'], ['testOnly', '仅单元测试'], ['unused', '完全没用到']] as const).map(([k, label]) => (
            <button key={k} className={`btn sm ${filter === k ? 'primary' : ''}`} onClick={() => setFilter(k)}>
              {label}{c ? ` ${k === 'all' ? c.total : k === 'used' ? c.demoUsed : k === 'testOnly' ? c.testOnly : c.unused}` : ''}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 11.5 }}>点行展开参数与调用位置</span>
        </div>

        {loading ? (
          <div className="loading">加载中…</div>
        ) : symbols.length === 0 ? (
          <div className="loading">
            这个库还没有接口清单。先确认代码已拉取（库管理页「拉取仓库代码」），再点右上角「采集接口清单」。
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 200 }}>符号</th>
                <th style={{ width: 70 }}>类型</th>
                <th>签名</th>
                <th style={{ width: 90 }}>demo 调用</th>
                <th style={{ width: 90 }}>单元测试</th>
                <th style={{ width: 220 }}>声明位置</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <Fragment key={s.id}>
                  <tr onClick={() => setExpanded(expanded === s.id ? null : s.id)} style={{ cursor: 'pointer' }}>
                    <td className="mono">
                      {s.deprecated && <span className="tag amber">废弃</span>} {s.name}
                    </td>
                    <td><span className="tag gray">{KIND_LABEL[s.kind] ?? s.kind}</span></td>
                    <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{s.signature || '—'}</td>
                    <td>
                      {s.demoCallCount > 0
                        ? <span className="tag green">{s.demoCallCount} 处</span>
                        : <span className="tag red">未调用</span>}
                    </td>
                    <td>{s.testCallCount > 0 ? <span className="tag blue">{s.testCallCount} 处</span> : <span className="muted">—</span>}</td>
                    <td className="muted mono" style={{ fontSize: 11 }}>{s.sourceFile}:{s.sourceLine}</td>
                  </tr>
                  {expanded === s.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel3)' }}>
                        <div style={{ padding: '6px 2px', fontSize: 12 }}>
                          <div>
                            <b>参数</b>：
                            {s.params.length === 0 ? <span className="muted">（无）</span> : s.params.map((p) => (
                              <span key={p.name} className="mono" style={{ marginRight: 10 }}>
                                {p.name}{p.optional ? '?' : ''}{p.type ? `: ${p.type}` : ''}{p.defaultValue ? ` = ${p.defaultValue}` : ''}
                                {p.doc ? <span className="muted"> // {p.doc}</span> : null}
                              </span>
                            ))}
                          </div>
                          {(s.returns.type || s.returns.doc) && (
                            <div style={{ marginTop: 4 }}><b>返回</b>：<span className="mono">{s.returns.type || '—'}</span> {s.returns.doc}</div>
                          )}
                          {s.throws.length > 0 && (
                            <div style={{ marginTop: 4 }}>
                              <b>异常</b>：{s.throws.map((t, i) => <span key={i} className="mono" style={{ marginRight: 10 }}>{t.type || 'Error'} {t.doc}</span>)}
                            </div>
                          )}
                          {s.methods.length > 0 && (
                            <div style={{ marginTop: 4 }}><b>方法（{s.methods.length}）</b>：<span className="mono">{s.methods.join(', ')}</span></div>
                          )}
                          {s.pages.length > 0 && <div style={{ marginTop: 4 }}><b>demo 调用页面</b>：{s.pages.join('、')}</div>}
                          {s.demoCallCount === 0 && (
                            <div style={{ marginTop: 6, color: 'var(--amber)' }}>
                              该符号在 demo（src/main）里没有被真实调用{s.testCallCount > 0 ? `，只有 ${s.testCallCount} 处 Hypium 单元测试调用` : ''}。
                              真机覆盖需要先在 demo 里加调用，或走「可测性判定」的补丁流程。
                            </div>
                          )}
                          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
                            签名可信度：{s.detailLevel === 'full' ? '有参数清单' : '仅有名字（未定位到定义体，见采集问题）'}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.demoAssets.length > 0 && (
        <div className="card">
          <b style={{ fontSize: 13 }}>demo 资产（{data.demoAssets.length}）</b>
          <div className="muted" style={{ fontSize: 11.5, margin: '4px 0 8px' }}>
            <span className="tag gray">page</span> 真机可达页面 · <span className="tag gray">control</span> 可交互控件 ·{' '}
            <span className="tag gray">param</span> 可注入数据点 · <span className="tag green">call</span> demo 里的库调用点 ·{' '}
            <span className="tag blue">test_call</span> 单元测试里的调用点（不计入真机覆盖）
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>类型</th>
                  <th style={{ width: 180 }}>名称</th>
                  <th style={{ width: 200 }}>页面</th>
                  <th style={{ width: 240 }}>位置</th>
                  <th>片段</th>
                </tr>
              </thead>
              <tbody>
                {data.demoAssets.slice(0, 300).map((a, i) => (
                  <tr key={i}>
                    <td><span className={`tag ${ASSET_TAG[a.kind] ?? 'gray'}`}>{a.kind}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{a.name}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{a.pagePath || '—'}</td>
                    <td className="muted mono" style={{ fontSize: 11 }}>{a.sourceFile}:{a.sourceLine}</td>
                    <td className="muted mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.snippet.slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
