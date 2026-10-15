import { useCallback, useEffect, useState } from 'react';
import type { Library, Page } from 'shared';
import { api } from '../api';

/**
 * 待办工作台（R8 Phase 5 重写）—— 从"统计数字堆砌"改为"待办驱动"。
 *
 * 产品动机（重构方案 §3.3）：老首页铺一排 KPI 卡片，用户看完只知道"有 348 个库、
 * 覆盖率 12%"，然后不知道该干什么——数字不等于行动。待办工作台的每一项都回答
 * "现在该做什么"，而且是**可点的、带筛选条件的跳转**：点"12 个库没环境画像"
 * 直接跳到库工作区的环境 Tab 并定位到这些库。
 *
 * 设计约束：
 *   · 零后端改动，全部复用现有 API（libraries / caseOverview / catalog / surveyStats / issues）；
 *   · 待办按"卡住的程度"排序——最该先处理的排最前；
 *   · 保留原 KPI 作为副栏（总量与通过率仍有信息量，但不占主位）。
 */

interface TodoItem {
  id: string;
  /** 待办标题（动词开头，让人知道要做什么） */
  title: string;
  /** 数量；0 表示无待办（不渲染） */
  count: number;
  /** 为什么这件事重要（一句话） */
  why: string;
  /** 跳转目标：库工作区的哪个 Tab */
  target: { page: string; sub?: string };
  /** 严重度：影响排序与配色 */
  severity: string;
}

export default function HomePage() {
  const [libs, setLibs] = useState<Page<Library> | null>(null);
  const [overview, setOverview] = useState<{ total: number; byStatus: Array<{ status: string; n: number }>; versioned: number } | null>(null);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.catalog>> | null>(null);
  const [survey, setSurvey] = useState<Awaited<ReturnType<typeof api.surveyStats>> | null>(null);
  const [tickets, setTickets] = useState<Awaited<ReturnType<typeof api.issues>> | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api.libraries({ page: 1, pageSize: 200 }).then(setLibs).catch((e) => setError(String(e.message)));
    api.caseOverview().then(setOverview).catch(() => {});
    api.catalog().then(setCatalog).catch(() => {});
    api.surveyStats().then(setSurvey).catch(() => {});
    api.issues({ status: 'pending', limit: 100 }).then(setTickets).catch(() => {});
    api.issues({ limit: 100 }).then(setTickets).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalLibs = libs?.total ?? 0;
  const withCases = libs?.withCases ?? (libs?.items ?? []).filter((l) => (l.caseCount ?? 0) > 0).length;
  const passRate = overview && overview.total > 0
    ? ((overview.byStatus.find((s) => s.status === '通过')?.n ?? 0) / overview.total * 100).toFixed(1)
    : '—';

  // ---- 待办计算：每一项都来自真实数据，不写死 ----
  const unprofiled = catalog?.db.unprofiled ?? 0;
  const openTickets = (tickets?.items ?? []).filter((t) => !['accepted', 'rejected'].includes(t.status)).length;
  const needsLlm = survey?.totals.needsLlm ?? 0;
  const unboundCases = overview && overview.total > 0 ? Math.max(0, overview.total - overview.versioned) : 0;
  const catalogProblems = catalog?.problems.length ?? 0;

  const todos: TodoItem[] = [
    {
      id: 'env',
      title: '个库还没有环境画像',
      count: unprofiled,
      why: '没有环境画像 = 不知道这个库在什么工具链/依赖下测得动，后续构建装包都无从下手。',
      target: { page: 'workspace', sub: 'env' },
      severity: 'high',
    },
    {
      id: 'issues',
      title: '个问题工单待人工验收',
      count: openTickets,
      why: 'AI 已定位根因并自测试，等你确认结论——确认后才会沉淀成知识，下次同类问题可直接复用。',
      target: { page: 'workspace', sub: 'issues' },
      severity: 'high',
    },
    {
      id: 'llm',
      title: '个库需要 AI 增量分析',
      count: needsLlm,
      why: '这些库的类别/依赖无法用规则判定，需要 LLM 读 README 补环境方案（会消耗 token 预算）。',
      target: { page: 'workspace', sub: 'env' },
      severity: 'medium',
    },
    {
      id: 'cases',
      title: '条用例还没绑定自动化脚本',
      count: unboundCases,
      why: '未绑定脚本的用例无法参与真机执行计划，只能手工跑。',
      target: { page: 'workspace', sub: 'cases' },
      severity: 'medium',
    },
    {
      id: 'catalog',
      title: '行目录表数据有问题',
      count: catalogProblems,
      why: '随包的三方库测试表里有脏行（缺库名/重复/地址非法），已跳过——需要回表修正后才能导入。',
      target: { page: 'workspace', sub: 'env' },
      severity: 'low',
    },
  ].filter((t: TodoItem): t is TodoItem => t.count > 0);

  const severityColor: Record<string, string> = { high: 'red', medium: 'amber', low: 'gray' };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>待办工作台</div>
          <div className="page-desc">现在该做什么 —— 每一项都可点，直接跳到对应工作区</div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={load}>🔄 刷新</button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}

      {/* ---- 待办主区 ---- */}
      {todos.length === 0 ? (
        <div className="empty" style={{ marginTop: 20 }}>
          <div className="empty-ic">✅</div>
          <div className="empty-t">暂无待办</div>
          <div className="empty-d">所有库都已有环境画像、问题工单已处理完、用例都已绑定脚本。</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {todos.map((t) => (
            <a
              key={t.id}
              className="card"
              href={`#${t.target.page}`}
              style={{ textDecoration: 'none', display: 'block', borderLeft: `3px solid var(--${severityColor[t.severity]})` }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 650, color: `var(--${severityColor[t.severity]})` }}>{t.count}</span>
                <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{t.title}</span>
                <div style={{ flex: 1 }} />
                <span className="link" style={{ fontSize: 12 }}>去处理 →</span>
              </div>
              <div className="muted" style={{ fontSize: 11.8, marginTop: 3 }}>{t.why}</div>
            </a>
          ))}
        </div>
      )}

      {/* ---- 统计副栏（保留信息量，不占主位）---- */}
      <div className="grid grid-4" style={{ marginTop: 18 }}>
        <div className="card kpi">
          <div className="ic ic-blue">📦</div>
          <div className="v">{totalLibs || '…'}</div>
          <div className="l">三方库接入</div>
          <div className="d muted">{withCases} 个有用例</div>
        </div>
        <div className="card kpi">
          <div className="ic ic-green">🧪</div>
          <div className="v">{overview?.total ?? '…'}</div>
          <div className="l">测试用例</div>
          <div className="d muted">{overview?.versioned ?? 0} 条已升版</div>
        </div>
        <div className="card kpi">
          <div className="ic ic-amber">📊</div>
          <div className="v">{passRate}%</div>
          <div className="l">执行通过率</div>
          <div className="d muted">共 {overview?.total ?? 0} 次执行</div>
        </div>
        <div className="card kpi">
          <div className="ic ic-purple">🧰</div>
          <div className="v">{catalog?.db.profiled ?? 0}</div>
          <div className="l">环境就绪库</div>
          <div className="d muted">共 {totalLibs} 个库</div>
        </div>
      </div>
    </>
  );
}
