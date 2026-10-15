import { useCallback, useEffect, useState } from 'react';
import type { Library, Page, TestCase } from 'shared';
import { api } from '../api';
import EnvPage from '../views/Env';
import SurveyPage from '../views/Survey';
import CasesPage from '../views/Cases';
import ScriptsPage from '../views/Scripts';
import ApiPage from '../views/Api';
import CoveragePage from '../views/Coverage';
import IssuePage from '../views/Issues';
import HumanQueuePage from '../views/HumanQueue';
import AttributionPage from '../views/Attribution';

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

/** 二级子 Tab：每个主 Tab 下挂多个完整功能视图（原独立页面）。 */
type SubTab = 'env' | 'survey' | 'cases' | 'scripts' | 'api' | 'coverage' | 'issues' | 'human' | 'attribution';

const SUB_TABS: Record<Exclude<Tab, 'overview'>, Array<{ key: SubTab; label: string; icon: string }>> = {
  env: [
    { key: 'env', label: '环境画像', icon: '🧰' },
    { key: 'survey', label: '全量采集', icon: '🔬' },
  ],
  cases: [
    { key: 'cases', label: '用例', icon: '🧪' },
    { key: 'scripts', label: '脚本', icon: '🤖' },
    { key: 'api', label: '接口面', icon: '🔌' },
    { key: 'coverage', label: '覆盖矩阵', icon: '🧭' },
  ],
  issues: [
    { key: 'issues', label: '问题归因', icon: '🩺' },
    { key: 'human', label: '人工队列', icon: '🙋' },
    { key: 'attribution', label: '执行归因', icon: '🔍' },
  ],
};

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
  const [subTab, setSubTab] = useState<SubTab>('env');
  // 切换主 Tab 时把子 Tab 复位到该组的第一个。
  // 不加这段会出静默空白：subTab 默认 'env'，切到「用例」组（子 Tab 是
  // cases/scripts/api/coverage）时无匹配项，四个子 Tab 渲染出来但内容区全空、
  // 且没有激活态——用户看到的就是"点过去什么都没发生"。
  useEffect(() => {
    if (tab === 'overview') return;
    const first = SUB_TABS[tab]?.[0]?.key;
    if (first) setSubTab(first);
  }, [tab]);
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

              {/* ---- 环境（二级 Tab：环境画像 / 全量采集）---- */}
              {tab === 'env' && (
                <>
                  <div className="ws-subtabs">
                    {SUB_TABS.env.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className={`ws-subtab ${subTab === s.key ? 'active' : ''}`}
                        onClick={() => setSubTab(s.key)}
                      >
                        <span className="ico">{s.icon}</span>{s.label}
                      </button>
                    ))}
                  </div>
                  <div className="ws-subbody">
                    {subTab === 'env' && <EnvPage fixedLibraryId={sel ?? undefined} />}
                    {subTab === 'survey' && <SurveyPage />}
                  </div>
                </>
              )}

              {/* ---- 用例（二级 Tab：用例 / 脚本 / 接口面 / 覆盖矩阵）---- */}
              {tab === 'cases' && (
                <>
                  <div className="ws-subtabs">
                    {SUB_TABS.cases.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className={`ws-subtab ${subTab === s.key ? 'active' : ''}`}
                        onClick={() => setSubTab(s.key)}
                      >
                        <span className="ico">{s.icon}</span>{s.label}
                      </button>
                    ))}
                  </div>
                  <div className="ws-subbody">
                    {subTab === 'cases' && <CasesPage fixedLibraryId={sel ?? undefined} />}
                    {subTab === 'scripts' && <ScriptsPage fixedLibraryId={sel ?? undefined} />}
                    {subTab === 'api' && <ApiPage fixedLibraryId={sel ?? undefined} />}
                    {subTab === 'coverage' && <CoveragePage fixedLibraryId={sel ?? undefined} />}
                  </div>
                </>
              )}

              {/* ---- 问题（二级 Tab：问题归因 / 人工队列 / 执行归因）---- */}
              {tab === 'issues' && (
                <>
                  <div className="ws-subtabs">
                    {SUB_TABS.issues.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className={`ws-subtab ${subTab === s.key ? 'active' : ''}`}
                        onClick={() => setSubTab(s.key)}
                      >
                        <span className="ico">{s.icon}</span>{s.label}
                      </button>
                    ))}
                  </div>
                  <div className="ws-subbody">
                    {subTab === 'issues' && <IssuePage fixedLibraryId={sel ?? undefined} />}
                    {subTab === 'human' && <HumanQueuePage fixedLibraryId={sel ?? undefined} />}
                    {subTab === 'attribution' && <AttributionPage />}
                  </div>
                </>
              )}

            </div>
          </>
        )}
      </div>
    </div>
  );
}
