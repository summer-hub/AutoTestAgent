import { useCallback, useEffect, useState } from 'react';
import type { Baseline, Library, TestRun, TestRunDetail } from 'shared';
import { api } from '../api';

/**
 * B1 测试基线（设计 §11.4）：
 *  - 库维度基线列表：编号、版本、commit、来源、大小、创建时间、引用数
 *  - 操作：从最新/tag/commit 创建；校验；归档；删除（后端按引用受限）
 *  - 磁盘占用提示 + 最近运行（test_runs）记录
 *  - 基线不可变：ready 后只读，没有"编辑"入口
 */

const SOURCE_LABEL: Record<string, string> = { latest: '最新提交', tag: 'Tag', manual: '指定 Commit', pr: 'PR 合入' };
const SOURCE_TAG: Record<string, string> = { latest: 'blue', tag: 'purple', manual: 'cyan', pr: 'amber' };
const STATUS_TAG: Record<string, string> = { ready: 'green', archived: 'gray', creating: 'blue', failed: 'red' };

function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function BaselinesPage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState(0);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [runDetail, setRunDetail] = useState<TestRunDetail | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ source: 'latest' as 'latest' | 'tag' | 'manual', ref: '', versionLabel: '', note: '' });

  const loadBaselines = useCallback((id: number) => {
    if (!id) { setBaselines([]); return; }
    api.baselines(id).then(setBaselines).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => {
    api.librariesAll().then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId((prev) => prev || r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
    api.testRuns({ limit: 20 }).then(setRuns).catch(() => {});
  }, []);

  useEffect(() => { loadBaselines(libId); }, [libId, loadBaselines]);

  const lib = libs.find((l) => l.id === libId);
  const totalSize = baselines.reduce((s, b) => s + (b.sizeBytes ?? 0), 0);

  const create = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.createBaseline(libId, {
        source: form.source,
        ref: form.source === 'latest' ? undefined : form.ref.trim() || undefined,
        versionLabel: form.versionLabel.trim() || undefined,
        note: form.note.trim() || undefined,
      });
      setMsg(r.reused ? `该提交已有基线 ${r.baselineNo}，已直接复用` : `基线 ${r.baselineNo} 创建成功`);
      setCreateOpen(false);
      loadBaselines(libId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const verify = async (b: Baseline) => {
    setError(''); setMsg('');
    try {
      const r = await api.verifyBaseline(b.id);
      if (r.ok) setMsg(`${b.baselineNo} 校验通过（${fmtSize(r.sizeBytes)}）`);
      else setError(`${b.baselineNo} 校验发现问题：\n${r.problems.join('\n')}`);
    } catch (e) { setError((e as Error).message); }
  };

  const archive = async (b: Baseline) => {
    setError(''); setMsg('');
    try { await api.archiveBaseline(b.id); setMsg(`${b.baselineNo} 已归档（不再出现在计划可选项，物理快照保留）`); loadBaselines(libId); }
    catch (e) { setError((e as Error).message); }
  };

  const remove = async (b: Baseline) => {
    if (!window.confirm(`确定硬删基线 ${b.baselineNo}？物理快照目录将一并清理（有执行引用时后端会拒绝）。`)) return;
    setError(''); setMsg('');
    try { await api.deleteBaseline(b.id); setMsg(`${b.baselineNo} 已删除`); loadBaselines(libId); }
    catch (e) { setError((e as Error).message); }
  };

  const openRun = (r: TestRun) => {
    setRunDetail(null);
    api.testRun(r.id).then(setRunDetail).catch((e) => setError(String((e as Error).message)));
  };

  return (
    <>
      {error && <div className="error" style={{ whiteSpace: 'pre-wrap' }}>⚠️ {error}</div>}
      {msg && <div className="ok" style={{ marginBottom: 10 }}>{msg}</div>}

      {/* 库选择 + 磁盘占用 */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 280 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {lib && (
          <span className="muted" style={{ fontSize: 11.8 }}>
            {lib.repoUrl || '未配置仓库'}
            {lib.repoSubpath ? ` / ${lib.repoSubpath}` : ''}
            {lib.currentVersion ? ` · ${lib.currentVersion}` : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11.8 }}>
          该库基线 {baselines.length} 个 · 占用 {fmtSize(totalSize)}
        </span>
        <button className="btn primary sm" disabled={!libId} onClick={() => setCreateOpen(true)}>＋ 创建基线</button>
      </div>

      {/* 基线列表 */}
      {baselines.length === 0 ? (
        <div className="card"><div className="loading">
          {libId ? '该库暂无基线 —— 计划执行（latest 模式）时会按当前 HEAD 自动创建，也可手动创建。' : '请先选择库'}
        </div></div>
      ) : (
        baselines.map((b) => (
          <div key={b.id} className="card" style={{ marginBottom: 10, padding: '13px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="mono" style={{ color: 'var(--accent2)', fontWeight: 600 }}>{b.baselineNo}</span>
              <span className={`tag ${STATUS_TAG[b.status] ?? 'gray'}`}>{b.status === 'ready' ? '可用' : b.status === 'archived' ? '已归档' : b.status}</span>
              <span className={`tag ${SOURCE_TAG[b.source] ?? 'gray'}`}>{SOURCE_LABEL[b.source] ?? b.source}</span>
              {b.versionLabel && <span className="tag plain">{b.versionLabel}</span>}
              {b.referencedByPlan && <span className="tag amber" title="被固定基线计划引用：不可归档/删除">被计划引用</span>}
              <div style={{ flex: 1 }} />
              <span className="muted" style={{ fontSize: 11.5 }}>执行 {b.execCount} 次</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" onClick={() => verify(b)}>校验</button>
                <button className="btn sm ghost" disabled={b.status === 'archived'} onClick={() => archive(b)}>归档</button>
                <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={() => remove(b)}>删除</button>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 11.8, marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span className="mono" title={b.commitSha}>commit {b.commitSha.slice(0, 10)}</span>
              <span>{fmtSize(b.sizeBytes)}</span>
              <span>创建于 {b.createdAt}</span>
              {b.repoSubpath && <span>子目录 {b.repoSubpath}</span>}
              <span className="mono" title={b.relDir}>{b.relDir}</span>
            </div>
            {b.note && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>📝 {b.note}</div>}
          </div>
        ))
      )}

      {/* 最近运行（test_runs） */}
      <div className="card" style={{ padding: '12px 16px', marginTop: 16 }}>
        <div className="card-h"><span className="t">🧾 最近运行快照</span><span className="sub">每次计划执行生成一条 TR- 记录（含每库基线与用例版本快照）</span></div>
        {runs.length === 0 ? (
          <div className="loading">暂无运行记录（先在「执行计划」发起执行）</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {runs.map((r) => (
              <div
                key={r.id}
                onClick={() => openRun(r)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', fontSize: 12.3 }}
              >
                <span className={`tag ${r.status === 'failed' ? 'red' : r.status === 'running' ? 'blue' : 'green'}`}>{r.status}</span>
                <span className="mono" style={{ color: 'var(--accent2)' }}>{r.runNo}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.planName || r.planNo || '—'}
                </span>
                <span className="muted" style={{ fontSize: 11.3 }}>{r.startedAt ?? r.createdAt}</span>
              </div>
            ))}
          </div>
        )}
        {runDetail && (
          <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, fontSize: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <b className="mono" style={{ color: 'var(--accent2)' }}>{runDetail.runNo}</b>
              <span className={`tag ${runDetail.status === 'failed' ? 'red' : 'green'}`}>{runDetail.status}</span>
              {runDetail.error && <span style={{ color: 'var(--red)', fontSize: 11.5 }}>{runDetail.error}</span>}
            </div>
            {runDetail.items.length === 0 ? (
              <div className="muted">该运行无库级快照（历史运行或库未纳入基线追溯）</div>
            ) : runDetail.items.map((i) => (
              <div key={i.id} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
                <b style={{ minWidth: 120 }}>{i.libraryName}</b>
                <span className="mono" style={{ color: 'var(--accent2)' }}>{i.baselineNo || '—'}</span>
                <span className="mono muted">{i.baselineLabel}</span>
                <span className="mono muted">commit {i.commitSha.slice(0, 10)}</span>
                <span className="muted">用例版本 {i.caseVersions ? Object.keys(i.caseVersions).length : 0} 份快照</span>
                <span className={`tag ${i.status === 'failed' ? 'red' : 'green'}`}>{i.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建基线抽屉 */}
      {createOpen && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setCreateOpen(false); }}>
          <div className="drawer" style={{ width: 520 }}>
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>创建基线 · {lib?.name}</span>
              <span className="x" onClick={() => setCreateOpen(false)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <div className="fl"><div className="ft">来源</div></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, flex: 1 }}>
                  {([['latest', '📌', '最新提交', '工作克隆当前 HEAD'], ['tag', '🏷️', 'Tag', '按 tag 定位提交'], ['manual', '✍️', '指定 Commit', '手动填 commit 哈希']] as const).map(([v, icon, label, desc]) => (
                    <div
                      key={v}
                      style={{ border: `1px solid ${form.source === v ? 'var(--accent)' : 'var(--border2)'}`, background: form.source === v ? 'var(--accent-dim)' : 'transparent', borderRadius: 9, padding: '10px 12px', cursor: 'pointer' }}
                      onClick={() => setForm({ ...form, source: v })}
                    >
                      <div style={{ fontWeight: 600, fontSize: 12.3 }}>{icon} {label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{desc}</div>
                    </div>
                  ))}
                </div>
              </div>
              {form.source !== 'latest' && (
                <div className="s-field" style={{ marginBottom: 12 }}>
                  <div className="fl"><div className="ft">{form.source === 'tag' ? 'Tag 名' : 'Commit 哈希'}</div></div>
                  <input
                    className="input mono"
                    style={{ flex: 1 }}
                    value={form.ref}
                    onChange={(e) => setForm({ ...form, ref: e.target.value })}
                    placeholder={form.source === 'tag' ? '如 v1.13.0' : '如 640c8760（完整或短哈希）'}
                  />
                </div>
              )}
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">版本标签（可选）</div></div>
                <input className="input" style={{ flex: 1 }} value={form.versionLabel} onChange={(e) => setForm({ ...form, versionLabel: e.target.value })} placeholder="如 v1.13.0（默认取来源版本）" />
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">备注（可选）</div></div>
                <input className="input" style={{ flex: 1 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="如 发布前冻结版本" />
              </div>
              <div className="muted" style={{ fontSize: 11.8, lineHeight: 1.7, marginBottom: 10 }}>
                基线 = 物理快照（workspace/baselines/…）+ 库子目录视角，创建后<b>只读不可变</b>。
                同一提交重复创建会自动复用已有快照。需要本地已克隆该库的仓库。
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
                <button className="btn primary" disabled={busy || (form.source !== 'latest' && !form.ref.trim())} onClick={create}>
                  {busy ? '创建中…' : '创建基线'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
