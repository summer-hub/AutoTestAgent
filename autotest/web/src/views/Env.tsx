import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 环境准备页（R1 新增纵轴）。
 *
 * 这一页回答三个问题，对应平台"链头"的三件事：
 *   ① 有哪些**脚本资产**可用（ohpm_安装 / 构建 har·hap / 装机）——契约与失败分类可见；
 *   ② 每个库的**环境画像**是什么（工具链 + 依赖 + 步骤序列）——能否进入可测状态；
 *   ③ **环境准备跑过没有**、失败在哪一步、归成哪一类——失败必须可归类，不能是一段原文。
 *
 * 为什么单独一页而不是塞进库管理：环境准备是"从克隆到装包"的独立生命周期，
 * 与用例/执行不同轴；混在一起会让"这个库到底准备好了没有"这件事看不见。
 */
export default function EnvPage({ fixedLibraryId }: { fixedLibraryId?: number } = {}) {
  const [scripts, setScripts] = useState<Awaited<ReturnType<typeof api.envScripts>> | null>(null);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof api.envProfiles>> | null>(null);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof api.envRuns>> | null>(null);
  const [tab, setTab] = useState<'scripts' | 'profiles' | 'runs'>('scripts');
  const [detail, setDetail] = useState<number | null>(null);
  const [detailData, setDetailData] = useState<Awaited<ReturnType<typeof api.envRun>> | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api.envScripts().then(setScripts).catch((e) => setError(String((e as Error).message)));
    api.envProfiles(fixedLibraryId ?? 0).then(setProfiles).catch((e) => setError(String((e as Error).message)));
    api.envRuns().then(setRuns).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const runProfile = async (id: number) => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.envProfileRun(id, {});
      setMsg(r.status === 'cached'
        ? `已复用上次环境准备结果（未重跑，run #${r.cachedFrom}）`
        : `环境准备完成：${r.status}${r.error ? `（${r.error}）` : ''}`);
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const openRun = async (id: number) => {
    setDetail(id); setDetailData(null);
    try { setDetailData(await api.envRun(id)); }
    catch (e) { setError(String((e as Error).message)); }
  };

  const statusTag = (s: string) => {
    const cls = s === 'passed' ? 'green' : s === 'failed' ? 'red' : s === 'cached' ? 'blue' : 'gray';
    return <span className={`tag ${cls}`}>{s}</span>;
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>环境准备</div>
          <div className="page-desc">
            从克隆代码到装上包的链头：脚本资产 · 环境画像 · 环境准备运行
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={load} disabled={busy}>刷新</button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {([['scripts', '脚本资产'], ['profiles', '环境画像'], ['runs', '运行记录']] as const).map(([k, label]) => (
          <button key={k} className={`btn sm ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/* ---------- 脚本资产 ---------- */}
      {tab === 'scripts' && scripts && (
        <div style={{ marginTop: 12 }}>
          {scripts.drift.length > 0 && (
            <div className="error" style={{ marginBottom: 10 }}>
              ⚠️ {scripts.drift.length} 个脚本契约与记录不一致（升级后需重跑锁）：{scripts.drift.map((d) => d.id).join(', ')}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            共 {scripts.items.length} 个脚本资产。契约七项（输入/输出/适用条件/失败分类/幂等/超时/审批）是平台唯一依据——
            脚本实现可按需替换，平台不认实现细节。
          </div>
          {scripts.items.map((s) => (
            <div key={s.id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b className="mono">{s.id}</b>
                <span className="tag gray">v{s.version}</span>
                {s.builtin ? <span className="tag blue">内置</span> : <span className="tag gray">自定义</span>}
                {s.enabled ? '' : <span className="tag amber">已禁用</span>}
                <span className="tag gray">审批：{s.approval}</span>
                <span className="tag gray">超时 {Math.round(s.timeoutSec / 60)}min</span>
                {s.idempotent ? <span className="tag green">幂等</span> : <span className="tag amber">非幂等</span>}
                <div style={{ flex: 1 }} />
                <span className="muted mono" style={{ fontSize: 11 }}>{s.sha256.slice(0, 8)}</span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{s.summary}</div>
              <div style={{ fontSize: 11.5, marginTop: 6 }}>
                <span className="muted">输入：</span>
                {s.inputs.length === 0 ? <span className="muted">无</span> : s.inputs.map((p) => (
                  <span key={p.name} className="tag gray" style={{ marginRight: 4 }}>
                    {p.name}:{p.type}{p.required ? '*' : ''}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, marginTop: 4 }}>
                <span className="muted">失败分类：</span>
                {s.failureTaxonomy.map((k) => (
                  <span key={k} className="tag gray" style={{ marginRight: 4 }}>{scripts.failureLabels[k] ?? k}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- 环境画像 ---------- */}
      {tab === 'profiles' && profiles && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            共 {profiles.items.length} 份画像。画像 = 这个库在什么工具链/依赖/步骤序列下才测得动；
            <b>draft</b> 表示尚未确认，确认后才用于环境准备。
          </div>
          {profiles.items.length === 0 && (
            <div className="card muted">还没有环境画像。R2 的全量分析流水线会按库类别自动生成；也可在此手动创建。</div>
          )}
          {profiles.items.map((p) => (
            <div key={p.id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b>{p.libraryName}</b>
                <span className="muted">{p.name}</span>
                {p.presetKind && <span className="tag blue">{p.presetKind}</span>}
                <span className="tag gray">来源 {p.source}</span>
                <span className="tag gray">置信度 {p.confidence}</span>
                <span className="tag gray">{p.stepCount} 步</span>
                {p.lastRunStatus && statusTag(p.lastRunStatus)}
                <div style={{ flex: 1 }} />
                <button className="btn sm primary" disabled={busy} onClick={() => void runProfile(p.id)}>
                  {busy ? '执行中…' : '执行环境准备'}
                </button>
              </div>
              {p.runCount > 0 && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>已运行 {p.runCount} 次</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------- 运行记录 ---------- */}
      {tab === 'runs' && runs && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            环境准备运行记录。<b>cached</b> = 指纹命中、未重跑（省时的关键）；
            <b>failed</b> 必带失败分类——归不进去说明码表该扩了。
          </div>
          {runs.items.length === 0 && <div className="card muted">还没有运行记录。</div>}
          {runs.items.map((r) => (
            <div key={r.id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b className="mono">{r.runNo}</b>
                <span className="muted">{r.libraryName}</span>
                {statusTag(r.status)}
                <span className="tag gray">{r.trigger}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>{(r.durationMs / 1000).toFixed(1)}s</span>
                {r.cachedFrom && <span className="tag blue">复用 #{r.cachedFrom}</span>}
                <div style={{ flex: 1 }} />
                <span className="link" onClick={() => void openRun(r.id)}>详情</span>
              </div>
              {r.error && (
                <div style={{ fontSize: 11.5, marginTop: 4, color: 'var(--red, #e5534b)' }}>{r.error}</div>
              )}
              {detail === r.id && detailData && (
                <div style={{ marginTop: 8 }}>
                  {detailData.steps.map((s) => (
                    <div key={s.seq} style={{ fontSize: 11.8, marginBottom: 4, paddingLeft: 8, borderLeft: '2px solid var(--border, #333)' }}>
                      <span className="mono">#{s.seq} {s.scriptId}</span>{' '}
                      {s.status === 'passed'
                        ? <span className="tag green">通过</span>
                        : <span className="tag red">{scripts?.failureLabels[s.failureKind] ?? s.failureKind}</span>}
                      <span className="muted"> {(s.durationMs / 1000).toFixed(1)}s</span>
                      {s.artifacts.filter((a) => a.exists).map((a) => (
                        <div key={a.name} className="muted mono" style={{ fontSize: 10.5 }}>
                          📦 {a.name} · {(a.size / 1024).toFixed(0)}KB · {a.sha256.slice(0, 8)}
                        </div>
                      ))}
                      {s.logPath && <div className="muted mono" style={{ fontSize: 10.5 }}>📄 {s.logPath}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
