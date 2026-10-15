import { useCallback, useEffect, useState } from 'react';
import type { Library, Page, TestCase } from 'shared';
import { api } from '../api';

/**
 * 库工作区（Phase 1 · 双轨期）—— R8 信息架构重构的新主轴入口。
 *
 * 产品动机（见 docs/前端信息架构重构方案.md）：老结构把"围绕一个库做事"切成
 * 10 个页面 + 10 次重复选库；这里把它收成一个工作区——左列表选库、右侧 4 个 Tab
 * 概览/环境/用例/问题，全部复用现有 API，**不改任何后端**。
 *
 * Phase 1 的定位是"双轨"：老 20 页一行不改，这个工作区作为新入口并行存在，
 * 用着不顺随时可回退。因此每个 Tab 只做"这个库的紧凑视图 + 跳转到老页面做深度操作"，
 * 不做功能重写——深度能力仍在原页面，避免双轨期出现两套行为不一致的实现。
 */

type Tab = 'overview' | 'env' | 'cases' | 'issues';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'overview', label: '概览', icon: '📊' },
  { key: 'env', label: '环境', icon: '🧰' },
  { key: 'cases', label: '用例', icon: '🧪' },
  { key: 'issues', label: '问题', icon: '🩺' },
];

/** 环境健康度：由该库的环境画像与最近运行推导（无画像=未配置）。 */
function envHealth(profiles: Array<{ lastRunStatus: string }>): { label: string; cls: string } {
  if (profiles.length === 0) return { label: '未配置环境', cls: 'gray' };
  const last = profiles[0]?.lastRunStatus;
  if (last === 'passed') return { label: '环境就绪', cls: 'green' };
  if (last === 'failed') return { label: '环境失败', cls: 'red' };
  return { label: '环境待验证', cls: 'amber' };
}

export default function LibraryWorkspace() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // 左列表分页：服务端 /libraries 的 pageSize 上限是 100，348 个库必须分页加载，
  // 否则用户只能看到前 100 个——"所有库都能直接看到"就落了空。
  const [libTotal, setLibTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingLibs, setLoadingLibs] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 各 Tab 数据（按需加载，不全量预拉）
  const [profiles, setProfiles] = useState<Array<{
    id: number; name: string; status: string; presetKind: string; source: string;
    confidence: number; stepCount: number; runCount: number; lastRunStatus: string;
  }>>([]);
  const [runs, setRuns] = useState<Array<{
    id: number; runNo: string; status: string; trigger: string; durationMs: number;
    error: string; createdAt: string;
  }>>([]);
  const [casePage, setCasePage] = useState<Page<TestCase> | null>(null);
  const [tickets, setTickets] = useState<Array<{
    id: number; ticketNo: string; symptom: string; status: string;
    rootCause: { confidence: number; analysisBy: string } | null; createdAt: string;
  }>>([]);
  const [queue, setQueue] = useState<{ total: number; open: number; byStage: Record<string, number> } | null>(null);

  const selected = libs.find((l) => l.id === sel) ?? null;

  // 左列表：分页加载。服务端 /libraries 的 pageSize 上限是 100，348 个库必须分页，
  // 否则用户只能看到前 100 个。搜索词变化时重置回第 1 页。
  const loadLibs = useCallback(async (targetPage: number) => {
    const reset = targetPage <= 1;
    if (reset) { setError(''); setLoadingLibs(true); } else { setLoadingMore(true); }
    try {
      const r = await api.libraries({ page: targetPage, pageSize: 100, q: q || undefined });
      setLibs((prev) => (reset ? r.items : [...prev, ...r.items]));
      setLibTotal(r.total);
      setPage(targetPage);
      setHasMore(targetPage * 100 < r.total);
      if (reset) {
        // 默认选中第一个，避免右侧空白
        setSel((prev) => (prev && r.items.some((l) => l.id === prev) ? prev : r.items[0]?.id ?? null));
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      if (reset) setLoadingLibs(false);
      setLoadingMore(false);
    }
  }, [q]);

  useEffect(() => { void loadLibs(1); }, [loadLibs]);

  const loadMore = (): void => { if (!loadingMore && hasMore) void loadLibs(page + 1); };

  // 右侧数据：随选中库 / Tab 变化按需加载
  const loadTab = useCallback(async (id: number, t: Tab) => {
    setError('');
    try {
      if (t === 'overview' || t === 'env') {
        const [p, r] = await Promise.all([
          api.envProfiles(id),
          api.envRuns(id, 10),
        ]);
        setProfiles(p.items);
        setRuns(r.items);
      }
      if (t === 'overview' || t === 'cases') {
        setCasePage(await api.cases(id, { pageSize: 20 }));
      }
      if (t === 'overview' || t === 'issues') {
        const [tk, hq] = await Promise.all([
          api.issues({ libraryId: id, limit: 50 }),
          api.humanQueue(id, 'open').catch(() => null),
        ]);
        setTickets(tk.items);
        setQueue(hq ? { total: hq.total, open: hq.open, byStage: hq.byStage } : null);
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => { if (sel) void loadTab(sel, tab); }, [sel, tab, loadTab]);

  const runEnv = async (profileId: number) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.envProfileRun(profileId, {});
      setMsg(r.status === 'cached'
        ? `已复用上次环境准备结果（未重跑，#${r.cachedFrom}）`
        : `环境准备完成：${r.status}${r.error ? `（${r.error}）` : ''}`);
      if (sel) await loadTab(sel, tab);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const health = envHealth(profiles);
  const caseTotal = casePage?.total ?? 0;
  const openTickets = tickets.filter((t) => !['accepted', 'rejected'].includes(t.status)).length;

  return (
    <div className="ws">
      {/* 左：库列表 */}
      <aside className="ws-list">
        <div className="ws-list-h">
          <input
            className="input"
            placeholder="搜索库名…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {libTotal > 0 ? `已加载 ${libs.length} / ${libTotal} 个库` : `${libs.length} 个库`}
          </div>
        </div>
        <div className="ws-list-body">
          {libs.map((l) => (
            <div
              key={l.id}
              className={`ws-item ${l.id === sel ? 'active' : ''}`}
              onClick={() => setSel(l.id)}
              title={`${l.name}${l.repoSubpath ? ` · ${l.repoSubpath}` : ''}`}
            >
              <span className="ws-item-name">{l.name}</span>
              <span className="ws-item-meta">
                {l.caseCount ? `${l.caseCount} 用例` : '无用例'}
                {l.packageName ? '' : ' · 缺包名'}
              </span>
            </div>
          ))}
          {libs.length === 0 && <div className="empty"><div className="empty-d">没有匹配的库</div></div>}
          {hasMore && (
            <button
              type="button"
              className="btn sm"
              style={{ width: '100%', marginTop: 6 }}
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? '加载中…' : `加载更多（${libs.length}/${libTotal}）`}
            </button>
          )}
        </div>
      </aside>

      {/* 右：工作区 */}
      <div className="ws-main">
        {!selected && <div className="empty"><div className="empty-t">从左侧选择一个库</div></div>}
        {selected && (
          <>
            <div className="ws-head">
              <div>
                <div className="ws-title">{selected.name}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {selected.repoUrl || '（未配置仓库地址）'}
                  {selected.repoSubpath ? ` · ${selected.repoSubpath}` : ''}
                  {selected.currentVersion ? ` · ${selected.currentVersion}` : ''}
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <span className={`tag ${health.cls}`}>{health.label}</span>
              <span className="tag gray">{caseTotal} 用例</span>
              {openTickets > 0 && <span className="tag amber">{openTickets} 待处理问题</span>}
            </div>

            <div className="ws-tabs">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`ws-tab ${tab === t.key ? 'active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  <span className="ico">{t.icon}</span>{t.label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {/* 双轨期：深度操作仍回老页面，避免两套实现行为不一致 */}
              <a className="link" style={{ fontSize: 11.5 }} href={`#libraries`}>库管理 ↗</a>
              <a className="link" style={{ fontSize: 11.5, marginLeft: 10 }} href={`#env`}>环境准备 ↗</a>
              <a className="link" style={{ fontSize: 11.5, marginLeft: 10 }} href={`#cases`}>测试用例 ↗</a>
              <a className="link" style={{ fontSize: 11.5, marginLeft: 10 }} href={`#issues`}>问题归因 ↗</a>
            </div>

            {error && <div className="error">⚠️ {error}</div>}
            {msg && <div className="ok">✓ {msg}</div>}

            <div className="ws-body">
              {/* ---- 概览 ---- */}
              {tab === 'overview' && (
                <div className="grid-3">
                  <div className="card">
                    <div className="muted" style={{ fontSize: 11.5 }}>环境</div>
                    <div style={{ fontSize: 15, fontWeight: 600, margin: '4px 0' }}>
                      {profiles.length > 0 ? `${profiles.length} 份画像` : '未配置'}
                    </div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {runs[0] ? `最近运行：${runs[0].status} · ${(runs[0].durationMs / 1000).toFixed(1)}s` : '尚无运行记录'}
                    </div>
                  </div>
                  <div className="card">
                    <div className="muted" style={{ fontSize: 11.5 }}>用例</div>
                    <div style={{ fontSize: 15, fontWeight: 600, margin: '4px 0' }}>{caseTotal} 条</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {casePage?.items.filter((c) => c.scriptStatus === '已绑定').length ?? 0} 条已绑定脚本
                    </div>
                  </div>
                  <div className="card">
                    <div className="muted" style={{ fontSize: 11.5 }}>问题</div>
                    <div style={{ fontSize: 15, fontWeight: 600, margin: '4px 0' }}>{openTickets} 待处理</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      人工队列 {queue?.open ?? 0} 条
                    </div>
                  </div>
                </div>
              )}

              {/* ---- 环境 ---- */}
              {tab === 'env' && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                    环境画像 = 这个库在什么工具链 / 依赖 / 步骤序列下才测得动。运行记录是"从克隆到装包"的真实执行。
                  </div>
                  {profiles.length === 0 && (
                    <div className="empty">
                      <div className="empty-ic">🧰</div>
                      <div className="empty-t">还没有环境画像</div>
                      <div className="empty-d">到「全量分析」页跑一次采集，或按预设类别生成画像。</div>
                    </div>
                  )}
                  {profiles.map((p) => (
                    <div key={p.id} className="card" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <b>{p.name}</b>
                        {p.presetKind && <span className="tag blue">{p.presetKind}</span>}
                        <span className="tag gray">来源 {p.source}</span>
                        <span className="tag gray">{p.stepCount} 步</span>
                        <span className="tag gray">置信度 {p.confidence}</span>
                        {p.lastRunStatus && (
                          <span className={`tag ${p.lastRunStatus === 'passed' ? 'green' : p.lastRunStatus === 'failed' ? 'red' : 'gray'}`}>
                            {p.lastRunStatus}
                          </span>
                        )}
                        <div style={{ flex: 1 }} />
                        <button className="btn sm primary" disabled={busy} onClick={() => void runEnv(p.id)}>
                          {busy ? '执行中…' : '发起环境准备'}
                        </button>
                      </div>
                    </div>
                  ))}
                  {runs.length > 0 && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 6px' }}>最近运行</div>
                      <table>
                        <thead><tr><th>运行号</th><th>状态</th><th>触发</th><th>耗时</th><th>说明</th></tr></thead>
                        <tbody>
                          {runs.map((r) => (
                            <tr key={r.id}>
                              <td className="mono">{r.runNo}</td>
                              <td>
                                <span className={`tag ${r.status === 'passed' ? 'green' : r.status === 'cached' ? 'blue' : r.status === 'failed' ? 'red' : 'gray'}`}>
                                  {r.status}
                                </span>
                              </td>
                              <td>{r.trigger}</td>
                              <td className="muted">{(r.durationMs / 1000).toFixed(1)}s</td>
                              <td className="muted">{r.error || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </>
              )}

              {/* ---- 用例 ---- */}
              {tab === 'cases' && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                    该库的用例与脚本绑定状态。完整编辑 / 版本历史 / 补丁评审请到「测试用例」页。
                  </div>
                  {casePage && casePage.items.length > 0 ? (
                    <table>
                      <thead><tr><th>编号</th><th>名称</th><th>状态</th><th>脚本</th><th>可测性</th></tr></thead>
                      <tbody>
                        {casePage.items.map((c) => (
                          <tr key={c.id}>
                            <td className="mono">{c.caseNo}</td>
                            <td>{c.name}</td>
                            <td><span className="tag gray">{c.status}</span></td>
                            <td>
                              <span className={`tag ${c.scriptStatus === '已绑定' ? 'green' : 'gray'}`}>{c.scriptStatus}</span>
                            </td>
                            <td className="muted">{c.testability || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="empty">
                      <div className="empty-ic">🧪</div>
                      <div className="empty-t">还没有用例</div>
                      <div className="empty-d">到「任务管理」用 AI 生成，或从 Excel 导入。</div>
                    </div>
                  )}
                </>
              )}

              {/* ---- 问题 ---- */}
              {tab === 'issues' && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                    人对用例的疑问 → AI 定位根因 → 自测试 → 人工验收。以及自动化跑不了进人工队列的条目。
                  </div>
                  {tickets.length === 0 && (queue?.open ?? 0) === 0 && (
                    <div className="empty">
                      <div className="empty-ic">🩺</div>
                      <div className="empty-t">没有待处理问题</div>
                    </div>
                  )}
                  {tickets.map((t) => (
                    <div key={t.id} className="card" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <b className="mono" style={{ fontSize: 12 }}>{t.ticketNo}</b>
                        <span className={`tag ${t.status === 'accepted' ? 'green' : t.status === 'rejected' ? 'red' : 'amber'}`}>
                          {t.status}
                        </span>
                        {t.rootCause && <span className="tag gray">置信度 {t.rootCause.confidence}</span>}
                      </div>
                      <div style={{ fontSize: 12.5, marginTop: 4 }}>{t.symptom}</div>
                    </div>
                  ))}
                  {(queue?.open ?? 0) > 0 && (
                    <div className="card" style={{ marginTop: 8 }}>
                      <b>人工队列</b>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {queue?.open} 条阻塞待处理：
                        {Object.entries(queue?.byStage ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}
                      </div>
                      <a className="link" style={{ fontSize: 12 }} href="#human">去处理 ↗</a>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
