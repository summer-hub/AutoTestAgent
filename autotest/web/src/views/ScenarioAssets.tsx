import { useCallback, useEffect, useRef, useState } from 'react';
import type { Library, ScenarioAsset, ScenarioAssetDetail, ScenarioAssetKind, ScenarioKind } from 'shared';
import { api } from '../api';

/**
 * B2 场景资产（设计 §11.6）：
 *  - 列表：编号、库、类型（OneBox/页面/fixture/config/mixed）、场景、状态、关联用例数、版本
 *  - 新建向导：选类型 → 填元数据（OneBox 链接/本地文件后补）→ 静态校验 → 关联用例
 *  - 详情：文件清单+上传、Markdown 配置指导、版本历史、关联用例、应用记录
 *  - 与「测试资源」Tab 分工：这里是"场景资产"（有入口/指导/版本/关联），数据资源在隔壁
 */

const KIND_LABEL: Record<ScenarioAssetKind, string> = {
  onebox_link: 'OneBox 链接', demo_page: 'Demo 页面', fixture: 'Fixture', config: '配置指导', mixed: '组合',
};
const KIND_TAG: Record<ScenarioAssetKind, string> = {
  onebox_link: 'blue', demo_page: 'purple', fixture: 'cyan', config: 'amber', mixed: 'outline',
};
const SCENARIO_LABEL: Record<ScenarioKind, string> = {
  happy: '正常路径', empty: '空数据', boundary: '边界', bigdata: '大数据量', general: '通用',
};
const STATUS_TAG: Record<string, string> = { draft: 'amber', validated: 'green', deprecated: 'gray' };
const STATUS_LABEL: Record<string, string> = { draft: '草稿', validated: '已校验', deprecated: '已下架' };

function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 单文件 → base64（分块转换，避免大数组展开爆栈）。 */
async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

interface CaseLite { id: number; caseNo: string; name: string }

export default function ScenarioAssetsView() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState(0);
  const [items, setItems] = useState<ScenarioAsset[]>([]);
  const [filters, setFilters] = useState({ kind: '', status: '', scenarioKind: '', q: '' });
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<ScenarioAssetDetail | null>(null);
  const [libCases, setLibCases] = useState<CaseLite[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 新建表单
  const [form, setForm] = useState<{
    kind: ScenarioAssetKind; title: string; scenarioKind: ScenarioKind;
    uri: string; entryHint: string; configGuideMd: string; minVersion: string;
  }>({ kind: 'onebox_link', title: '', scenarioKind: 'general', uri: '', entryHint: '', configGuideMd: '', minVersion: '' });

  const load = useCallback(() => {
    api.scenarioAssets({ ...filters, libraryId: libId || undefined }).then((r) => setItems(r.items))
      .catch((e) => setError(String((e as Error).message)));
  }, [filters, libId]);

  useEffect(() => {
    api.libraries({ pageSize: 100 }).then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId((prev) => prev || r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => { load(); }, [load]);

  // 库切换时预载该库用例（关联用例下拉）
  useEffect(() => {
    if (!libId) { setLibCases([]); return; }
    api.cases(libId, { pageSize: 200 }).then((r) => {
      setLibCases(r.items.map((c) => ({ id: c.id, caseNo: c.caseNo, name: c.name })));
    }).catch(() => setLibCases([]));
  }, [libId]);

  const openDetail = (a: ScenarioAsset | ScenarioAssetDetail) => {
    setError(''); setMsg('');
    api.scenarioAsset(a.id).then(setDetail).catch((e) => setError(String((e as Error).message)));
  };

  const create = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await api.createScenarioAsset({
        libraryId: libId,
        title: form.title.trim(),
        kind: form.kind,
        scenarioKind: form.scenarioKind,
        uri: (form.kind === 'onebox_link' || form.kind === 'mixed') && form.uri.trim() ? form.uri.trim() : undefined,
        entryHint: form.entryHint.trim() || undefined,
        configGuideMd: form.configGuideMd.trim() || undefined,
        compat: form.minVersion.trim() ? { minVersion: form.minVersion.trim() } : undefined,
      });
      setMsg(`资产 ${r.assetNo} 创建成功（V1）。${form.kind === 'onebox_link' ? '可立即静态校验。' : '请在详情中上传文件。'}`);
      setCreateOpen(false);
      setForm({ kind: 'onebox_link', title: '', scenarioKind: 'general', uri: '', entryHint: '', configGuideMd: '', minVersion: '' });
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const uploadFiles = async (a: ScenarioAssetDetail, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(''); setMsg(''); setBusy(true);
    try {
      // 按 base64 总量分批（请求体上限 2MB；单文件 2MB / 总量 20MB 由后端校验）
      const batches: Array<Array<{ path: string; contentBase64: string; role: string }>> = [[]];
      let batchBytes = 0;
      for (const f of Array.from(files)) {
        const b64 = await fileToBase64(f);
        if (batchBytes + b64.length > 1_400_000) { batches.push([]); batchBytes = 0; }
        batches[batches.length - 1].push({ path: f.name, contentBase64: b64, role: guessRole(f.name) });
        batchBytes += b64.length;
      }
      let lastVersion = '';
      for (const batch of batches) {
        if (batch.length === 0) continue;
        const r = await api.uploadScenarioAssetFiles(a.id, batch, `web 上传 ${batch.length} 个文件`);
        lastVersion = r.version;
      }
      setMsg(`已上传 ${files.length} 个文件，资产版本 → V${lastVersion}`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      openDetail(a);
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const validate = async (a: ScenarioAssetDetail) => {
    setError(''); setMsg('');
    try {
      const r = await api.validateScenarioAsset(a.id);
      if (r.ok) setMsg(`${a.assetNo} 静态校验通过（V${a.version}）`);
      else setError(`${a.assetNo} 校验发现问题：\n${r.problems.join('\n')}`);
      openDetail(a); load();
    } catch (e) { setError((e as Error).message); }
  };

  const linkCase = async (a: ScenarioAssetDetail, caseId: number) => {
    if (!caseId) return;
    setError(''); setMsg('');
    try {
      const r = await api.linkScenarioAssetCases(a.id, [caseId]);
      setMsg(r.linked > 0 ? '已关联用例' : '该用例已关联（幂等）');
      openDetail(a); load();
    } catch (e) { setError((e as Error).message); }
  };

  const deprecate = async (a: ScenarioAssetDetail) => {
    if (!window.confirm(`确定下架 ${a.assetNo}？下架后不可编辑/应用，历史运行记录保留。`)) return;
    setError(''); setMsg('');
    try { await api.deprecateScenarioAsset(a.id); setMsg(`${a.assetNo} 已下架`); setDetail(null); load(); }
    catch (e) { setError((e as Error).message); }
  };

  const remove = async (a: ScenarioAssetDetail) => {
    if (!window.confirm(`确定删除 ${a.assetNo}？仅草稿且无关联时可删（后端受限）。`)) return;
    setError(''); setMsg('');
    try { await api.deleteScenarioAsset(a.id); setMsg(`${a.assetNo} 已删除`); setDetail(null); load(); }
    catch (e) { setError((e as Error).message); }
  };

  const download = async (a: ScenarioAssetDetail) => {
    setError(''); setMsg('');
    try {
      await api.downloadScenarioAssetZip(a.id, `${a.assetNo}-v${a.version}.zip`);
    } catch (e) { setError((e as Error).message); }
  };

  const isOnebox = form.kind === 'onebox_link';
  const needGuide = form.kind === 'onebox_link' || form.kind === 'config';

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        场景资产 = 测试场景需要的"页面/入口/配置指导/OneBox 链接"（设计 §8）。
        与「测试资源」的区别：资源是输入数据，这里是<b>场景本身</b>——有版本、有 sha256、可关联用例、运行时按版本快照回查。
      </div>

      {error && <div className="error" style={{ whiteSpace: 'pre-wrap' }}>⚠️ {error}</div>}
      {msg && <div className="ok" style={{ marginBottom: 10 }}>✓ {msg}</div>}

      {/* 过滤 + 新建 */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 220 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="select" style={{ width: 130 }} value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
          <option value="">全部类型</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="select" style={{ width: 120 }} value={filters.scenarioKind} onChange={(e) => setFilters({ ...filters, scenarioKind: e.target.value })}>
          <option value="">全部场景</option>
          {Object.entries(SCENARIO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="select" style={{ width: 110 }} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" style={{ width: 160 }} placeholder="搜索编号/标题" value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={!libId} onClick={() => setCreateOpen(true)}>＋ 登记资产</button>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-ic">🧩</div>
          <div className="empty-t">还没有场景资产</div>
          <div className="empty-d">登记 OneBox 链接、demo 页面、fixture 或配置指导，用例即可按版本引用。</div>
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>编号</th><th>标题</th><th>类型</th><th>场景</th><th>状态</th><th>版本</th><th>文件</th><th>用例</th><th>更新时间</th></tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} style={{ cursor: 'pointer', opacity: a.status === 'deprecated' ? 0.55 : 1 }} onClick={() => openDetail(a)}>
                <td className="mono">{a.assetNo}</td>
                <td>{a.title}</td>
                <td><span className={`tag ${KIND_TAG[a.kind]}`}>{KIND_LABEL[a.kind]}</span></td>
                <td>{SCENARIO_LABEL[a.scenarioKind]}</td>
                <td><span className={`tag ${STATUS_TAG[a.status]}`}>{STATUS_LABEL[a.status]}</span></td>
                <td className="mono">V{a.version}</td>
                <td className="muted">{a.kind === 'onebox_link' ? '—' : a.fileCount}</td>
                <td className="muted">{a.caseCount}</td>
                <td className="muted" style={{ fontSize: 11 }}>{a.updatedAt.slice(0, 16).replace('T', ' ')}</td>
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
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>登记场景资产 · {libs.find((l) => l.id === libId)?.name}</span>
              <span className="x" onClick={() => setCreateOpen(false)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <div className="fl"><div className="ft">类型</div></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, flex: 1 }}>
                  {(Object.keys(KIND_LABEL) as ScenarioAssetKind[]).map((k) => (
                    <div key={k}
                      style={{ border: `1px solid ${form.kind === k ? 'var(--accent)' : 'var(--border2)'}`, background: form.kind === k ? 'var(--accent-dim)' : 'transparent', borderRadius: 9, padding: '9px 10px', cursor: 'pointer' }}
                      onClick={() => setForm({ ...form, kind: k })}>
                      <div style={{ fontWeight: 600, fontSize: 12.3 }}>{KIND_LABEL[k]}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11.3, marginBottom: 12 }}>
                {isOnebox ? '只存链接与配置指导，不抓取内容（§8.2）。' : '文件在创建后从详情页上传（base64，单文件 2MB / 总量 20MB）。'}
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">标题 *</div></div>
                <input className="input" style={{ flex: 1 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：空列表 demo 页" />
              </div>
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">适用场景</div></div>
                <select className="select" style={{ width: 160 }} value={form.scenarioKind} onChange={(e) => setForm({ ...form, scenarioKind: e.target.value as ScenarioKind })}>
                  {(Object.keys(SCENARIO_LABEL) as ScenarioKind[]).map((k) => <option key={k} value={k}>{SCENARIO_LABEL[k]}</option>)}
                </select>
                <div className="fl" style={{ marginLeft: 10 }}><div className="ft">最低版本</div></div>
                <input className="input" style={{ width: 130 }} value={form.minVersion} onChange={(e) => setForm({ ...form, minVersion: e.target.value })} placeholder="v1.2.0（可选）" />
              </div>
              {(isOnebox || form.kind === 'mixed') && (
                <div className="s-field" style={{ marginBottom: 12 }}>
                  <div className="fl"><div className="ft">OneBox 链接{isOnebox ? ' *' : ''}</div></div>
                  <input className="input mono" style={{ flex: 1 }} value={form.uri} onChange={(e) => setForm({ ...form, uri: e.target.value })} placeholder="https://…" />
                </div>
              )}
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">入口提示</div></div>
                <input className="input" style={{ flex: 1 }} value={form.entryHint} onChange={(e) => setForm({ ...form, entryHint: e.target.value })} placeholder="如：pages/Index.ets 增加空列表入口按钮" />
              </div>
              <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <div className="fl"><div className="ft">配置指导{needGuide ? ' *' : ''}</div></div>
                <textarea className="input" rows={6} style={{ flex: 1 }} value={form.configGuideMd} onChange={(e) => setForm({ ...form, configGuideMd: e.target.value })}
                  placeholder={'# 配置步骤\n1. …\n2. …'} />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
                <button className="btn primary" disabled={busy || !form.title.trim() || (isOnebox && !/^https?:\/\//.test(form.uri.trim())) || (needGuide && !form.configGuideMd.trim())} onClick={() => void create()}>
                  {busy ? '创建中…' : '创建（V1）'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 详情抽屉 */}
      {detail && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="drawer" style={{ width: 660 }}>
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14 }}>{detail.assetNo}</span>
              <span className={`tag ${KIND_TAG[detail.kind]}`}>{KIND_LABEL[detail.kind]}</span>
              <span className={`tag ${STATUS_TAG[detail.status]}`}>{STATUS_LABEL[detail.status]}</span>
              <span style={{ fontSize: 13 }}>{detail.title}</span>
              <span className="x" onClick={() => setDetail(null)}>✕</span>
            </div>
            <div className="drawer-b">
              {/* 元信息 chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                <span className="tag outline">V{detail.version}</span>
                <span className="tag outline">{SCENARIO_LABEL[detail.scenarioKind]}</span>
                {detail.sha256 && <span className="tag outline mono" title={detail.sha256}>sha {detail.sha256.slice(0, 10)}…</span>}
                {detail.validatedAt && <span className="tag green">校验于 {detail.validatedAt.slice(0, 16).replace('T', ' ')}</span>}
                {detail.compat?.minVersion && <span className="tag outline">≥ {detail.compat.minVersion}</span>}
                {detail.entryHint && <span className="tag amber">入口：{detail.entryHint}</span>}
              </div>
              {detail.uri && (
                <div style={{ marginBottom: 12, fontSize: 12.5 }}>
                  OneBox：<a className="mono" href={detail.uri} target="_blank" rel="noreferrer">{detail.uri}</a>
                </div>
              )}

              {/* 操作 */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
                  onChange={(e) => void uploadFiles(detail, e.target.files)} />
                {detail.kind !== 'onebox_link' && (
                  <button className="btn sm" disabled={busy || detail.status === 'deprecated'} onClick={() => fileInputRef.current?.click()}>
                    {busy ? '上传中…' : '上传文件（版本自增）'}
                  </button>
                )}
                <button className="btn sm primary" disabled={detail.status === 'deprecated'} onClick={() => void validate(detail)}>静态校验</button>
                {detail.kind !== 'onebox_link' && detail.files.length > 0 && (
                  <button className="btn sm" onClick={() => void download(detail)}>下载 zip</button>
                )}
                <button className="btn sm" disabled={detail.status === 'deprecated'} onClick={() => void deprecate(detail)}>下架</button>
                {detail.status === 'draft' && detail.cases.length === 0 && detail.runRefs.length === 0 && (
                  <button className="btn sm danger" onClick={() => void remove(detail)}>删除</button>
                )}
              </div>

              {/* 配置指导 */}
              <div className="ft" style={{ marginBottom: 4 }}>配置指导</div>
              <pre className="card" style={{ padding: 12, fontSize: 11.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', marginTop: 0, marginBottom: 14 }}>
                {detail.configGuideMd || '（无）'}
              </pre>

              {/* 文件清单 */}
              <div className="ft" style={{ marginBottom: 4 }}>文件（{detail.files.length}）</div>
              {detail.kind === 'onebox_link' ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>OneBox 链接资产不存本地文件（§8.2）。</div>
              ) : detail.files.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>尚未上传文件 —— 上传后版本自增并生成 manifest.json。</div>
              ) : (
                <table style={{ marginBottom: 12 }}>
                  <thead><tr><th>路径</th><th>大小</th><th>sha256</th><th>角色</th></tr></thead>
                  <tbody>
                    {detail.files.map((f) => (
                      <tr key={f.id}>
                        <td className="mono" style={{ fontSize: 11 }}>{f.path}</td>
                        <td className="muted">{fmtSize(f.size)}</td>
                        <td className="mono muted" style={{ fontSize: 10.5 }} title={f.sha256}>{f.sha256.slice(0, 12)}…</td>
                        <td><span className="tag gray">{f.role}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* 版本史 */}
              <div className="ft" style={{ marginBottom: 4 }}>版本历史</div>
              {detail.versions.map((v) => (
                <div key={v.id} style={{ display: 'flex', gap: 10, fontSize: 11.5, alignItems: 'center', marginBottom: 4 }}>
                  <span className="mono tag outline">V{v.version}</span>
                  <span className="mono muted" title={v.sha256}>{v.sha256 ? `${v.sha256.slice(0, 10)}…` : '（无文件）'}</span>
                  <span style={{ flex: 1 }}>{v.note}</span>
                  <span className="muted">{v.createdAt.slice(0, 16).replace('T', ' ')}</span>
                </div>
              ))}

              {/* 关联用例 */}
              <div className="ft" style={{ marginBottom: 4, marginTop: 12 }}>关联用例（前置资源，§8.6）</div>
              {detail.cases.length === 0 ? (
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>尚未关联 —— 关联后运行该用例时本资产按当前版本记入资源集。</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {detail.cases.map((c) => (
                    <span key={c.case_id} className="tag blue mono">{c.case_no} {c.name}</span>
                  ))}
                </div>
              )}
              {detail.status !== 'deprecated' && (
                <select className="select" style={{ width: 320 }} defaultValue={0}
                  onChange={(e) => { void linkCase(detail, Number(e.target.value)); e.currentTarget.value = '0'; }}>
                  <option value={0}>＋ 关联本库用例…</option>
                  {libCases.filter((c) => !detail.cases.some((d) => d.case_id === c.id)).map((c) => (
                    <option key={c.id} value={c.id}>{c.caseNo} {c.name}</option>
                  ))}
                </select>
              )}

              {/* 应用记录 */}
              {detail.runRefs.length > 0 && (
                <>
                  <div className="ft" style={{ marginBottom: 4, marginTop: 12 }}>应用记录（运行时按版本快照）</div>
                  {detail.runRefs.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontSize: 11.5, alignItems: 'center', marginBottom: 4 }}>
                      <span className="mono tag outline">{r.run_no}</span>
                      <span className="mono">V{r.version}</span>
                      <span className={`tag ${r.apply_status === 'applied' ? 'green' : r.apply_status === 'failed' ? 'red' : 'amber'}`}>{r.apply_status}</span>
                      <span className="muted">{r.created_at.slice(0, 16).replace('T', ' ')}</span>
                    </div>
                  ))}
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    recorded = 登记制：版本与 sha256 已写入该次运行的资源集（未注入运行副本；运行副本机制引入后升级为 applied）。
                  </div>
                </>
              )}

              <div className="muted" style={{ fontSize: 11, marginTop: 16 }}>
                {detail.libraryName} · 创建于 {detail.createdAt.slice(0, 10)} · 本地目录 {detail.kind === 'onebox_link' ? '（无）' : 'scenario-assets/…（详见 manifest）'}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 文件名 → 资产内角色（page/fixture/config 简单猜测，后端不强制）。 */
function guessRole(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ets') || lower.endsWith('.ts')) return 'page';
  if (lower.endsWith('.json5') || lower.endsWith('.cfg') || lower.includes('config')) return 'config';
  return 'fixture';
}
