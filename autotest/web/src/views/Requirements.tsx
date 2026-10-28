import { useCallback, useEffect, useState } from 'react';
import type { Library, PrListItem, Requirement, RequirementDetail, RequirementListItem, RequirementSource } from 'shared';
import { api } from '../api';

/**
 * 需求追踪（B4 · 设计 §11.2）—— 需求 → 用例 → 执行 的可追溯链路入口。
 *
 * 产品动机：需求只存 external_id + url + 验收点（不复制外部系统全文），
 * 统计（用例数/PR 数/最近失败/基线数）由关联表现算，不存冗余计数。
 */
const STATUS_LABEL: Record<string, string> = { active: '进行中', done: '已完成', closed: '已关闭', dropped: '已放弃' };
const STATUS_TAG: Record<string, string> = { active: 'blue', done: 'green', closed: 'gray', dropped: 'gray' };
const SOURCE_LABEL: Record<string, string> = { manual: '手工', onebox: 'OneBox', import: '导入' };

type CaseLite = { id: number; caseNo: string; name: string };

export default function RequirementsView({ fixedLibraryId }: { fixedLibraryId?: number }) {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState(fixedLibraryId ?? 0);
  const [items, setItems] = useState<RequirementListItem[]>([]);
  const [filters, setFilters] = useState({ status: '', q: '' });
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<RequirementDetail | null>(null);
  const [libCases, setLibCases] = useState<CaseLite[]>([]);
  const [libPrs, setLibPrs] = useState<PrListItem[]>([]);

  const [form, setForm] = useState<{
    title: string; source: RequirementSource; externalId: string; url: string;
    priority: string; acceptanceMd: string; owner: string;
  }>({ title: '', source: 'manual', externalId: '', url: '', priority: 'P1', acceptanceMd: '', owner: '' });

  const load = useCallback(() => {
    api.requirements({ ...filters, libraryId: libId || undefined, limit: 200 }).then((r) => setItems(r.items))
      .catch((e) => setError(String((e as Error).message)));
  }, [filters, libId]);

  useEffect(() => {
    if (fixedLibraryId) { setLibId(fixedLibraryId); return; }
    api.librariesAll().then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId((prev) => prev || r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
  }, [fixedLibraryId]);

  useEffect(() => { load(); }, [load]);

  // 预载库用例与 PR（详情关联下拉）
  useEffect(() => {
    if (!libId) { setLibCases([]); setLibPrs([]); return; }
    api.cases(libId, { pageSize: 300 }).then((r) => setLibCases(r.items.map((c) => ({ id: c.id, caseNo: c.caseNo, name: c.name }))))
      .catch(() => setLibCases([]));
    api.prsForLibrary(libId, { limit: 100 }).then((r) => setLibPrs((r.items as PrListItem[]).filter((p) => p.id)))
      .catch(() => setLibPrs([]));
  }, [libId]);

  const openDetail = (r: RequirementListItem) => {
    setError(''); setMsg('');
    api.requirementDetail(r.id).then(setDetail).catch((e) => setError(String((e as Error).message)));
  };

  const create = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.requirementCreate({
        title: form.title.trim(),
        source: form.source,
        externalId: form.externalId.trim() || undefined,
        url: form.url.trim() || undefined,
        primaryLibraryId: libId || null,
        priority: form.priority.trim() || undefined,
        acceptanceMd: form.acceptanceMd.trim() || undefined,
        owner: form.owner.trim() || undefined,
      });
      setMsg(`需求 ${r.requirementNo} 创建成功`);
      setCreateOpen(false);
      setForm({ title: '', source: 'manual', externalId: '', url: '', priority: 'P1', acceptanceMd: '', owner: '' });
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const updateStatus = async (r: RequirementDetail, status: string) => {
    setError(''); setMsg('');
    try {
      await api.requirementUpdate(r.id, { status });
      setMsg(`${r.requirementNo} 状态 → ${STATUS_LABEL[status] ?? status}`);
      openDetail(r); load();
    } catch (e) { setError((e as Error).message); }
  };

  const linkCase = async (r: RequirementDetail, caseId: number) => {
    if (!caseId) return;
    setError(''); setMsg('');
    try {
      const res = await api.requirementLinkCases(r.id, [caseId]);
      setMsg(res.linked > 0 ? '已关联用例' : '该用例已关联（幂等）');
      openDetail(r); load();
    } catch (e) { setError((e as Error).message); }
  };

  const unlinkCase = async (r: RequirementDetail, caseId: number) => {
    setError(''); setMsg('');
    try {
      await api.requirementUnlinkCase(r.id, caseId);
      setMsg('已解除关联');
      openDetail(r); load();
    } catch (e) { setError((e as Error).message); }
  };

  const linkPr = async (r: RequirementDetail, prId: number) => {
    if (!prId) return;
    setError(''); setMsg('');
    try {
      const res = await api.requirementLinkPrs(r.id, [prId]);
      setMsg(res.linked > 0 ? '已关联 PR' : '该 PR 已关联（幂等）');
      openDetail(r); load();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        需求 = 外部系统的引用（external_id + url + 验收点），不复制全文。
        列表统计（用例/PR/最近失败/基线）现算 —— 需求 → 用例 → 执行 → 基线的追溯链路从这里查。
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok" style={{ marginBottom: 10 }}>✓ {msg}</div>}

      {/* 过滤 + 新建 */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {!fixedLibraryId && (
          <select className="select" style={{ width: 220 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
            {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <select className="select" style={{ width: 130 }} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" style={{ width: 180 }} placeholder="搜索编号/标题/external_id" value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={() => setCreateOpen(true)}>＋ 登记需求</button>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-ic">📌</div>
          <div className="empty-t">还没有需求</div>
          <div className="empty-d">登记需求（只存 external_id + url + 验收点），再关联用例与 PR 建立追溯链路。</div>
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>编号</th><th>标题</th><th>来源</th><th>状态</th><th>优先级</th><th>用例</th><th>PR</th><th>基线</th><th>最近失败</th><th>更新时间</th></tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer', opacity: r.status === 'dropped' ? 0.55 : 1 }} onClick={() => openDetail(r)}>
                <td className="mono">{r.requirementNo}</td>
                <td>{r.title}</td>
                <td><span className="tag gray">{SOURCE_LABEL[r.source] ?? r.source}</span></td>
                <td><span className={`tag ${STATUS_TAG[r.status] ?? 'gray'}`}>{STATUS_LABEL[r.status] ?? r.status}</span></td>
                <td className="muted">{r.priority || '—'}</td>
                <td className="muted">{r.caseCount}</td>
                <td className="muted">{r.prCount}</td>
                <td className="muted">{r.baselineCount}</td>
                <td>{r.recentFailed > 0 ? <span className="tag red">{r.recentFailed}</span> : <span className="muted">0</span>}</td>
                <td className="muted" style={{ fontSize: 11 }}>{r.updatedAt.slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 新建抽屉 */}
      {createOpen && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setCreateOpen(false); }}>
          <div className="drawer" style={{ width: 540 }}>
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>登记需求</span>
              <span className="x" onClick={() => setCreateOpen(false)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">标题 *</div></div>
                <input className="input" style={{ flex: 1 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="如：列表为空时提示" />
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">来源</div></div>
                <select className="select" style={{ width: 140 }} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as RequirementSource })}>
                  {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <div className="fl" style={{ marginLeft: 10 }}><div className="ft">外部 ID</div></div>
                <input className="input mono" style={{ width: 150 }} value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })}
                  placeholder="如 JIRA-123（同源查重）" />
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">URL</div></div>
                <input className="input mono" style={{ flex: 1 }} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://…（跳回外部系统）" />
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">优先级</div></div>
                <select className="select" style={{ width: 100 }} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  {['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <div className="fl" style={{ marginLeft: 10 }}><div className="ft">负责人</div></div>
                <input className="input" style={{ width: 140 }} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="可选" />
              </div>
              <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <div className="fl"><div className="ft">验收点</div></div>
                <textarea className="input" rows={5} style={{ flex: 1 }} value={form.acceptanceMd} onChange={(e) => setForm({ ...form, acceptanceMd: e.target.value })}
                  placeholder={'- 列表为空时显示「暂无数据」\n- 不崩溃'} />
              </div>
              <div className="muted" style={{ fontSize: 11.3, marginBottom: 12 }}>
                只存引用与验收点，不复制外部系统全文（§7.1）；external_id 同源重复会被拒（409）。
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
                <button className="btn primary" disabled={busy || !form.title.trim()} onClick={() => void create()}>
                  {busy ? '创建中…' : '创建'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 详情抽屉 */}
      {detail && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="drawer" style={{ width: 640 }}>
            <div className="drawer-h">
              <span className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>{detail.requirementNo}</span>
              <span className={`tag ${STATUS_TAG[detail.status] ?? 'gray'}`}>{STATUS_LABEL[detail.status] ?? detail.status}</span>
              <span style={{ fontSize: 13, flex: 1 }}>{detail.title}</span>
              <span className="x" onClick={() => setDetail(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                <span className="tag outline">{SOURCE_LABEL[detail.source] ?? detail.source}</span>
                {detail.priority && <span className="tag outline">{detail.priority}</span>}
                {detail.owner && <span className="tag outline">{detail.owner}</span>}
                {detail.externalId && <span className="tag outline mono">{detail.externalId}</span>}
              </div>
              {detail.url && (
                <div style={{ marginBottom: 12, fontSize: 12.5 }}>
                  外部链接：<a className="mono" href={detail.url} target="_blank" rel="noreferrer">{detail.url}</a>
                </div>
              )}

              {/* 状态切换 */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                  <button key={k} className={`btn sm ${detail.status === k ? 'primary' : ''}`} onClick={() => void updateStatus(detail, k)}>{v}</button>
                ))}
              </div>

              {/* 验收点 */}
              {detail.acceptanceMd && (
                <>
                  <div className="ft" style={{ marginBottom: 4 }}>验收点</div>
                  <pre className="card" style={{ padding: 12, fontSize: 11.5, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto', marginTop: 0, marginBottom: 14 }}>
                    {detail.acceptanceMd}
                  </pre>
                </>
              )}

              {/* 关联用例 */}
              <div className="ft" style={{ marginBottom: 4 }}>关联用例（{detail.cases.length}）</div>
              {detail.cases.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>尚未关联 —— 关联后可从需求追到用例的执行与失败。</div>
              ) : (
                <table style={{ marginBottom: 8 }}>
                  <thead><tr><th>用例</th><th>关系</th><th>状态</th><th></th></tr></thead>
                  <tbody>
                    {detail.cases.map((c) => (
                      <tr key={c.id}>
                        <td className="mono" style={{ fontSize: 11 }}>{c.caseNo} {c.name}</td>
                        <td><span className="tag gray">{c.relation}</span></td>
                        <td className="muted">{c.status}</td>
                        <td><button className="btn sm" onClick={() => void unlinkCase(detail, c.id)}>解除</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <select className="select" style={{ width: 340, marginBottom: 14 }} defaultValue={0}
                onChange={(e) => { void linkCase(detail, Number(e.target.value)); e.currentTarget.value = '0'; }}>
                <option value={0}>＋ 关联用例…</option>
                {libCases.filter((c) => !detail.cases.some((d) => d.id === c.id)).map((c) => (
                  <option key={c.id} value={c.id}>{c.caseNo} {c.name}</option>
                ))}
              </select>

              {/* 关联 PR */}
              <div className="ft" style={{ marginBottom: 4 }}>关联 PR（{detail.prs.length}）</div>
              {detail.prs.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>尚未关联 —— 需求 → PR → 基线的链路缺口在这里补。</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {detail.prs.map((p) => (
                    <span key={p.id} className="tag blue mono">#{p.number} {p.title.slice(0, 24)}{p.title.length > 24 ? '…' : ''}</span>
                  ))}
                </div>
              )}
              {libPrs.filter((p) => !detail.prs.some((d) => d.id === p.id)).length > 0 && (
                <select className="select" style={{ width: 340, marginBottom: 14 }} defaultValue={0}
                  onChange={(e) => { void linkPr(detail, Number(e.target.value)); e.currentTarget.value = '0'; }}>
                  <option value={0}>＋ 关联 PR…</option>
                  {libPrs.filter((p) => !detail.prs.some((d) => d.id === p.id)).map((p) => (
                    <option key={p.id} value={p.id}>#{p.number} {p.title}</option>
                  ))}
                </select>
              )}

              {/* 关联场景资产 */}
              {detail.scenarioAssets.length > 0 && (
                <>
                  <div className="ft" style={{ marginBottom: 4 }}>场景资产（{detail.scenarioAssets.length}）</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {detail.scenarioAssets.map((s) => (
                      <span key={s.id} className="tag purple mono">{s.assetNo} {s.title.slice(0, 20)}{s.title.length > 20 ? '…' : ''}</span>
                    ))}
                  </div>
                </>
              )}

              <div className="muted" style={{ fontSize: 11, marginTop: 16 }}>
                创建于 {detail.createdAt.slice(0, 10)} · 用例 {detail.caseCount} · PR {detail.prCount} · 基线 {detail.baselineCount} · 最近失败 {detail.recentFailed}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
