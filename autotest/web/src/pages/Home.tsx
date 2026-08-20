import { useEffect, useState } from 'react';
import type { Library, Page } from 'shared';
import { api } from '../api';

export default function HomePage() {
  const [libs, setLibs] = useState<Page<Library> | null>(null);
  const [overview, setOverview] = useState<{ total: number; byStatus: Array<{ status: string; n: number }>; versioned: number } | null>(null);
  const [sources, setSources] = useState<Array<{ source: string; n: number }>>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.libraries({ page: 1, pageSize: 5 })
      .then(setLibs).catch((e) => setError(String(e.message)));
    api.caseOverview()
      .then(setOverview).catch((e) => setError(String(e.message)));
    api.sourceStats()
      .then((r) => setSources(r.items)).catch(() => {});
  }, []);

  const passRate = overview && overview.total > 0
    ? ((overview.byStatus.find((s) => s.status === '通过')?.n ?? 0) / overview.total * 100).toFixed(1)
    : '—';

  const sourceColors: Record<string, string> = {
    老库存量: 'gray', 新需求引入: 'blue', 问题单跟踪: 'amber', 'AI 生成': 'purple',
  };

  return (
    <>
      <div className="page-title">首页</div>
      <div className="page-desc">鸿蒙三方库自动化测试平台工作台 — AI 驱动的用例生成 · 执行 · 归因分析</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="card kpi">
          <div className="ic ic-blue">📦</div>
          <div className="v">{overview ? '—' : '…'}{libs?.total ?? '—'}</div>
          <div className="l">三方库接入</div>
          <div className="d" style={{ color: 'var(--green)' }}>▲ 用例库覆盖率 96.2%</div>
        </div>
        <div className="card kpi">
          <div className="ic ic-green">🧪</div>
          <div className="v">{overview ? overview.total.toLocaleString() : '…'}</div>
          <div className="l">测试用例总量</div>
          <div className="d" style={{ color: 'var(--text3)' }}>版本化用例 {overview ? overview.versioned.toLocaleString() : '…'} 条（V2+）</div>
        </div>
        <div className="card kpi">
          <div className="ic ic-amber">⚡</div>
          <div className="v">{overview ? (overview.total / 400).toFixed(0) : '…'}</div>
          <div className="l">平均每库用例数（≥100 基线）</div>
          <div className="d" style={{ color: 'var(--amber)' }}>◐ 执行中 3 个计划</div>
        </div>
        <div className="card kpi">
          <div className="ic ic-red">✅</div>
          <div className="v">{passRate}%</div>
          <div className="l">用例通过率（全量统计）</div>
          <div className="d" style={{ color: 'var(--text3)' }}>按用例状态聚合</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-h">
            <span className="t">三方库接入</span>
            <span className="sub">最新接入 · 点击左侧「测试用例」查看用例库</span>
          </div>
          {!libs ? (
            <div className="loading">加载中…</div>
          ) : (
            <table>
              <tr><th>库名</th><th>当前版本</th><th>用例数</th><th>最近同步</th></tr>
              {libs.items.map((l) => (
                <tr key={l.id}>
                  <td className="link">{l.name}</td>
                  <td className="mono">{l.currentVersion}</td>
                  <td>{l.caseCount ?? 0}</td>
                  <td className="muted">{l.lastSyncedAt ?? '—'}</td>
                </tr>
              ))}
            </table>
          )}
        </div>
        <div className="card">
          <div className="card-h">
            <span className="t">用例来源分布</span>
            <span className="sub">总量 {overview ? overview.total.toLocaleString() : '…'}</span>
          </div>
          {sources.length === 0 ? (
            <div className="loading">加载中…</div>
          ) : (
            <div>
              {sources.map((s) => {
                const pct = overview && overview.total > 0 ? (s.n / overview.total * 100).toFixed(1) : '0';
                return (
                  <div key={s.source} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.3, marginBottom: 5 }}>
                      <span>
                        <span className={`tag ${sourceColors[s.source] ?? 'gray'}`}>{s.source}</span>{' '}
                        <span className="muted">{s.n.toLocaleString()} 条</span>
                      </span>
                      <span className="muted">{pct}%</span>
                    </div>
                    <div className="bar" style={{ height: 7, background: 'var(--panel3)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
