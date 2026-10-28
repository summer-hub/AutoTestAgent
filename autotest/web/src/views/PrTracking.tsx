import { useCallback, useEffect, useState } from 'react';
import type { Library, PrDetail, PrListItem, PrTestStatus, RequirementListItem } from 'shared';
import { api } from '../api';

/**
 * PR 跟踪（B4 · 设计 §11.3）—— PR → 基线 → 执行 的追溯与测试状态派生。
 *
 * 关键纪律：
 * - merge_commit_sha 拿不到留空，不编造（本地降级 PR 的 head 是提交、不是合入提交）；
 * - 从 PR 建基线：merge = 合入提交；head = 显式预验证通道（note 标注"不代表已合入主干"）；
 * - 测试状态派生（§7.3）：untested/testing/passed/failed/partial，不由 PR 表自维护。
 */
const STATUS_LABEL: Record<string, string> = { untested: '未测试', testing: '测试中', passed: '已通过', failed: '有失败', partial: '部分完成' };
const STATUS_TAG: Record<string, string> = { untested: 'gray', testing: 'blue', passed: 'green', failed: 'red', partial: 'amber' };

type CaseLite = { id: number; caseNo: string; name: string };

export default function PrTrackingView({ fixedLibraryId }: { fixedLibraryId?: number }) {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState(fixedLibraryId ?? 0);
  const [items, setItems] = useState<PrListItem[]>([]);
  const [source, setSource] = useState<'db' | 'git' | 'gitcode'>('db');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [libCases, setLibCases] = useState<CaseLite[]>([]);
  const [libRequirements, setLibRequirements] = useState<RequirementListItem[]>([]);
  const [versionLabel, setVersionLabel] = useState('');

  const load = useCallback(() => {
    if (!libId) return;
    api.prsForLibrary(libId, { limit: 100 }).then((r) => {
      setSource(r.source);
      // 表未同步时（git/gitcode 回退）items 无 id/派生字段 —— 展示只读列表并提示先同步
      setItems((r.items as PrListItem[]).map((p, i) => ({ ...p, id: p.id ?? -(i + 1) })));
    }).catch((e) => setError(String((e as Error).message)));
  }, [libId]);

  useEffect(() => {
    if (fixedLibraryId) { setLibId(fixedLibraryId); return; }
    api.librariesAll().then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId((prev) => prev || r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
  }, [fixedLibraryId]);

  useEffect(() => { load(); }, [load]);

  // 预载库用例与需求（详情关联下拉）
  useEffect(() => {
    if (!libId) { setLibCases([]); setLibRequirements([]); return; }
    api.cases(libId, { pageSize: 300 }).then((r) => setLibCases(r.items.map((c) => ({ id: c.id, caseNo: c.caseNo, name: c.name }))))
      .catch(() => setLibCases([]));
    api.requirements({ limit: 200 }).then((r) => setLibRequirements(r.items)).catch(() => setLibRequirements([]));
  }, [libId]);

  const sync = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.syncLibraryPrs(libId, { limit: 30 });
      setMsg(`同步完成：provider=${r.provider}，${r.synced} 条${r.note ? `（${r.note}）` : ''}`);
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const openDetail = (p: PrListItem) => {
    if (p.id < 0) { setMsg('该 PR 还未同步入库 —— 先点「同步 PR」落表，才能关联/建基线。'); return; }
    setError(''); setMsg('');
    api.prDetail(p.id).then(setDetail).catch((e) => setError(String((e as Error).message)));
  };

  const linkRequirement = async (p: PrDetail, requirementId: number) => {
    if (!requirementId) return;
    setError(''); setMsg('');
    try {
      const r = await api.prLinkRequirements(p.id, [requirementId]);
      setMsg(r.linked > 0 ? '已关联需求' : '该需求已关联（幂等）');
      api.prDetail(p.id).then(setDetail).catch(() => {});
      load();
    } catch (e) { setError((e as Error).message); }
  };

  const linkCase = async (p: PrDetail, caseId: number) => {
    if (!caseId) return;
    setError(''); setMsg('');
    try {
      const r = await api.prLinkCases(p.id, [caseId]);
      setMsg(r.linked > 0 ? '已关联用例' : '该用例已关联（幂等）');
      api.prDetail(p.id).then(setDetail).catch(() => {});
      load();
    } catch (e) { setError((e as Error).message); }
  };

  const createBaseline = async (p: PrDetail, ref: 'merge' | 'head') => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.prCreateBaseline(p.id, ref, versionLabel.trim() || undefined);
      setMsg(`基线 ${r.baseline.baseline_no} ${r.reused ? '（复用已有）' : '创建成功'}`);
      setVersionLabel('');
      api.prDetail(p.id).then(setDetail).catch(() => {});
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const testStatusChip = (s: PrTestStatus) => (
    <span className={`tag ${STATUS_TAG[s.status] ?? 'gray'}`} title={`基线 ${s.baselineCount} · 执行 ${s.executionCount}（通过 ${s.passedCount} / 失败 ${s.failedCount}）${s.lastRunAt ? ` · 最近 ${s.lastRunAt.slice(0, 16).replace('T', ' ')}` : ''}`}>
      {STATUS_LABEL[s.status] ?? s.status}
    </span>
  );

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        PR 跟踪 = 同步 PR（GitCode → 本地 git 降级）→ 关联需求/用例 → 从 merge 或 head 建基线 → 派生测试状态。
        测试状态从基线的执行现算（§7.3），PR 表不自维护；merge commit 拿不到留空，不编造。
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok" style={{ marginBottom: 10 }}>✓ {msg}</div>}

      {/* 同步栏 */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {!fixedLibraryId && (
          <select className="select" style={{ width: 220 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
            {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <span className={`tag ${source === 'db' ? 'green' : 'amber'}`}>
          {source === 'db' ? '已同步入库' : source === 'git' ? '本地 git（未入库）' : 'GitCode 实时（未入库）'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={busy || !libId} onClick={() => void sync()}>
          {busy ? '同步中…' : '⟳ 同步 PR'}
        </button>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-ic">🔀</div>
          <div className="empty-t">还没有 PR</div>
          <div className="empty-d">点「同步 PR」把 GitCode / 本地 git 的 PR 落表，才能关联需求、建基线、派生测试状态。</div>
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>#</th><th>标题</th><th>状态</th><th>分支</th><th>merge</th><th>head</th><th>需求</th><th>用例</th><th>基线</th><th>测试状态</th></tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} style={{ cursor: 'pointer', opacity: p.id < 0 ? 0.6 : 1 }} onClick={() => openDetail(p)}>
                <td className="mono">#{p.number}</td>
                <td>{p.title}</td>
                <td><span className={`tag ${p.state === 'merged' ? 'purple' : p.state === 'open' ? 'green' : 'gray'}`}>{p.state || '—'}</span></td>
                <td className="muted mono" style={{ fontSize: 10.5 }}>{p.headBranch || '—'}</td>
                <td className="mono muted" style={{ fontSize: 10.5 }}>{p.mergeCommitSha ? p.mergeCommitSha.slice(0, 7) : '（空）'}</td>
                <td className="mono muted" style={{ fontSize: 10.5 }}>{p.headSha ? p.headSha.slice(0, 7) : '—'}</td>
                <td className="muted">{p.requirementCount ?? '—'}</td>
                <td className="muted">{p.caseCount ?? '—'}</td>
                <td className="muted">{p.baselineCount ?? '—'}</td>
                <td>{p.testStatus ? testStatusChip(p.testStatus) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 详情抽屉 */}
      {detail && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="drawer" style={{ width: 660 }}>
            <div className="drawer-h">
              <span className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>#{detail.number}</span>
              <span className={`tag ${detail.state === 'merged' ? 'purple' : detail.state === 'open' ? 'green' : 'gray'}`}>{detail.state || '—'}</span>
              <span style={{ fontSize: 13, flex: 1 }}>{detail.title}</span>
              <span className="x" onClick={() => setDetail(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                {testStatusChip(detail.testStatus)}
                <span className="tag outline">{detail.provider}</span>
                {detail.author && <span className="tag outline">{detail.author}</span>}
                {detail.mergedAt && <span className="tag outline">合入 {detail.mergedAt.slice(0, 10)}</span>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11.5, marginBottom: 14 }}>
                <div>分支：<span className="mono muted">{detail.baseBranch || '—'} ← {detail.headBranch || '—'}</span></div>
                <div>merge commit：<span className="mono muted" title={detail.mergeCommitSha}>{detail.mergeCommitSha ? detail.mergeCommitSha.slice(0, 12) : '（空 —— 不编造）'}</span></div>
                <div>head：<span className="mono muted" title={detail.headSha}>{detail.headSha ? detail.headSha.slice(0, 12) : '—'}</span></div>
                <div>仓库：<span className="mono muted" style={{ wordBreak: 'break-all' }}>{detail.repoUrl}</span></div>
              </div>

              {/* 建基线 */}
              <div className="ft" style={{ marginBottom: 4 }}>从本 PR 建基线（§7.4）</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="input" style={{ width: 170 }} placeholder="版本标签（如 v1.2.0，可选）" value={versionLabel}
                  onChange={(e) => setVersionLabel(e.target.value)} />
                <button className="btn sm primary" disabled={busy || !detail.mergeCommitSha} title={detail.mergeCommitSha ? '用合入提交建基线' : 'merge commit 缺失 —— GitCode API 未返回或未合入'}
                  onClick={() => void createBaseline(detail, 'merge')}>用 merge 建基线</button>
                <button className="btn sm" disabled={busy || !detail.headSha} title="显式预验证：不代表已合入主干"
                  onClick={() => void createBaseline(detail, 'head')}>用 head 预验证</button>
              </div>
              {!detail.mergeCommitSha && (
                <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
                  merge commit 为空（未合入或 API 未返回）：用 merge 建基线会被拒（409，提示改用 head）；head 预验证 ≠ 已合入主干。
                </div>
              )}

              {/* 关联基线 */}
              <div className="ft" style={{ marginBottom: 4, marginTop: 12 }}>基线（{detail.baselines.length}）</div>
              {detail.baselines.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>尚无基线 —— 从上方建基线后，测试状态开始派生。</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {detail.baselines.map((b) => (
                    <span key={b.id} className="tag cyan mono" title={`commit ${b.commitSha}`}>{b.baselineNo}（{b.versionLabel || b.status}）</span>
                  ))}
                </div>
              )}

              {/* 关联需求 */}
              <div className="ft" style={{ marginBottom: 4, marginTop: 12 }}>关联需求（{detail.requirements.length}）</div>
              {detail.requirements.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>尚未关联。</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {detail.requirements.map((r) => (
                    <span key={r.id} className="tag blue mono">{r.requirementNo} {r.title.slice(0, 20)}{r.title.length > 20 ? '…' : ''}</span>
                  ))}
                </div>
              )}
              {libRequirements.filter((r) => !detail.requirements.some((d) => d.id === r.id)).length > 0 && (
                <select className="select" style={{ width: 340, marginBottom: 10 }} defaultValue={0}
                  onChange={(e) => { void linkRequirement(detail, Number(e.target.value)); e.currentTarget.value = '0'; }}>
                  <option value={0}>＋ 关联需求…</option>
                  {libRequirements.filter((r) => !detail.requirements.some((d) => d.id === r.id)).map((r) => (
                    <option key={r.id} value={r.id}>{r.requirementNo} {r.title}</option>
                  ))}
                </select>
              )}

              {/* 关联用例 */}
              <div className="ft" style={{ marginBottom: 4, marginTop: 12 }}>关联用例（{detail.cases.length}）</div>
              {detail.cases.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>尚未关联 —— 按 PR 改动文件关联的用例 basis=file，人工关联 basis=manual。</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {detail.cases.map((c) => (
                    <span key={c.id} className="tag outline mono" title={`basis: ${c.basis}`}>{c.caseNo} {c.name.slice(0, 18)}{c.name.length > 18 ? '…' : ''}</span>
                  ))}
                </div>
              )}
              <select className="select" style={{ width: 340 }} defaultValue={0}
                onChange={(e) => { void linkCase(detail, Number(e.target.value)); e.currentTarget.value = '0'; }}>
                <option value={0}>＋ 关联用例（basis=manual）…</option>
                {libCases.filter((c) => !detail.cases.some((d) => d.id === c.id)).map((c) => (
                  <option key={c.id} value={c.id}>{c.caseNo} {c.name}</option>
                ))}
              </select>

              <div className="muted" style={{ fontSize: 11, marginTop: 16 }}>
                {detail.libraryName} · 同步于 {detail.syncedAt ? detail.syncedAt.slice(0, 16).replace('T', ' ') : '（未知）'} ·
                执行 {detail.testStatus.executionCount}（通过 {detail.testStatus.passedCount} / 失败 {detail.testStatus.failedCount}）
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
