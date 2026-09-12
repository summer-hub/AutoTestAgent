import { useCallback, useEffect, useState } from 'react';
import type { Library, LibrarySheetSyncResult } from 'shared';
import { api } from '../api';

/**
 * 库管理：三方库的新增 / 编辑（重点是**包名**）/ 删除。
 *
 * 为什么单独做这一页：`libraries.package_name` 是真机遍历与执行的前提
 * （遍历靠它 `aa start` 拉起被测应用）。此前它只有「拉取仓库代码 → 解析 app.json5」
 * 一条填充路径，且后端没有任何库写入接口 —— 没拉过仓库的库包名永远为空，
 * 真机遍历会启动失败、dump 到桌面，整个遍历作废。所以这里必须能手工补包名，
 * 并提供「识别包名」从设备已安装应用里自动匹配。
 */
export default function LibrariesPage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(0);

  const [editing, setEditing] = useState<Library | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', repoUrl: '', repoSubpath: '', description: '', packageName: '', mainAbility: '' });
  const [candidates, setCandidates] = useState<{ lib: Library; items: Array<{ bundleName: string; mainAbility: string }> } | null>(null);
  const [sheet, setSheet] = useState<{ file: string; exists: boolean } | null>(null);
  const [preview, setPreview] = useState<LibrarySheetSyncResult | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.libraries({ pageSize: 100, q: q || undefined })
      .then((r) => { setLibs(r.items); setTotal(r.total); })
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setError('');
    setForm({ name: '', repoUrl: '', repoSubpath: '', description: '', packageName: '', mainAbility: '' });
    setEditing('new');
  };

  const openEdit = (lib: Library) => {
    setError('');
    setForm({
      name: lib.name, repoUrl: lib.repoUrl, repoSubpath: lib.repoSubpath ?? '', description: lib.description,
      packageName: lib.packageName ?? '', mainAbility: lib.mainAbility ?? '',
    });
    setEditing(lib);
  };

  const save = async () => {
    setError(''); setMsg('');
    try {
      if (editing === 'new') {
        const created = await api.createLibrary({
          name: form.name.trim(), repoUrl: form.repoUrl.trim(), repoSubpath: form.repoSubpath.trim(),
          description: form.description.trim(),
          packageName: form.packageName.trim(), mainAbility: form.mainAbility.trim(),
        });
        setMsg(`已新增库「${created.name}」${created.repoSubpath ? `（子目录 ${created.repoSubpath}）` : ''}`);
      } else if (editing) {
        await api.updateLibrary(editing.id, {
          name: form.name.trim(), repoUrl: form.repoUrl.trim(), repoSubpath: form.repoSubpath.trim(),
          description: form.description.trim(),
          packageName: form.packageName.trim(), mainAbility: form.mainAbility.trim(),
        });
        setMsg(`已保存「${form.name.trim()}」`);
      }
      setEditing(null);
      load();
    } catch (e) { setError(String((e as Error).message)); }
  };

  /**
   * 从粘贴的仓库地址里自动拆出单体仓子目录。
   * 三方库表 269 行里 171 行是 `.../openharmony_tpc_samples/tree/master/json-schema` 这种地址，
   * 如果只存整个仓库地址，克隆会按库各存一份 591MB（168 个库 ≈ 97GB），工程解析也找不到子目录。
   */
  const onRepoUrlChange = (value: string) => {
    const m = /\/tree\/[^/]+\/(.+?)\/?$/.exec(value.trim());
    setForm((f) => ({
      ...f,
      repoUrl: value,
      repoSubpath: m ? decodeURIComponent(m[1]) : f.repoSubpath,
    }));
  };

  // 删除：先不带 force 调一次，服务端若因有关联数据拒绝（409 且提示 force），再让用户二次确认
  const remove = async (lib: Library) => {
    setError(''); setMsg('');
    try {
      await api.deleteLibrary(lib.id);
      setMsg(`已删除库「${lib.name}」（本地克隆目录未删除，如需清理请手动处理）`);
      load();
    } catch (e) {
      const text = String((e as Error).message);
      if (!/force=1/.test(text)) { setError(text); return; }
      if (window.confirm(`${lib.name}\n\n${text}\n\n确认连同关联数据一起删除？此操作不可撤销。`)) {
        try {
          const r = await api.deleteLibrary(lib.id, true);
          setMsg(`已删除库「${r.deleted}」（用例 ${r.impact.cases} / 任务 ${r.impact.tasks} / 执行记录 ${r.impact.executions} 一并删除；本地克隆目录 ${r.repoDirKept} 保留）`);
          load();
        } catch (e2) { setError(String((e2 as Error).message)); }
      }
    }
  };

  // 识别包名：命中唯一时服务端直接落库；命中多个时弹候选让人选
  const detect = async (lib: Library) => {
    setError(''); setMsg(''); setBusy(lib.id);
    try {
      const r = await api.detectBundle(lib.id);
      if (r.saved) {
        setMsg(`已识别并写入：${r.bundleName}${r.mainAbility ? `（入口 ${r.mainAbility}）` : ''}`);
        load();
      } else if (r.candidates.length === 0) {
        setMsg(`设备上没有找到与「${lib.name}」匹配的应用，请确认应用已安装或手工填写包名`);
      } else {
        setCandidates({ lib, items: r.candidates });
      }
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(0); }
  };

  const useCandidate = async (bundleName: string, mainAbility: string) => {
    if (!candidates) return;
    const lib = candidates.lib;
    setCandidates(null);
    try {
      await api.updateLibrary(lib.id, { packageName: bundleName, mainAbility: mainAbility || lib.mainAbility });
      setMsg(`「${lib.name}」包名已设为 ${bundleName}`);
      load();
    } catch (e) { setError(String((e as Error).message)); }
  };

  const missingPkg = libs.filter((l) => !(l.packageName ?? '').trim()).length;

  // ---- 三方库测试表（xlsx）同步 ----
  // 表是人维护的（有哪些库、对应哪个仓库），库表里 Agent 补的包名/入口 Ability 不参与同步。
  useEffect(() => {
    api.sheetInfo().then((r) => setSheet(r)).catch(() => { /* 未配置也不影响本页其它功能 */ });
  }, []);

  const previewSheet = async () => {
    setError(''); setMsg(''); setBusy(-1); setPreview(null);
    try {
      const r = await api.syncSheet({ apply: false });
      setPreview(r);
      if (r.counts.added + r.counts.updated === 0) {
        setMsg(`已是最新：表里 ${r.total} 个库，没有需要写入的改动`);
      }
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(0); }
  };

  const applySheet = async () => {
    if (!preview) return;
    const c = preview.counts;
    if (!window.confirm(`将写入 ${c.added} 个新库、更新 ${c.updated} 个库的仓库地址。\n\n不会改动任何库的包名/入口 Ability，也不会删除库。确认执行？`)) return;
    setError(''); setMsg(''); setBusy(-1);
    try {
      const r = await api.syncSheet({ apply: true });
      setPreview(null);
      setMsg(`同步完成：新增 ${r.counts.added} · 更新 ${r.counts.updated} · 无变化 ${r.counts.unchanged}${r.counts.problems ? ` · 跳过 ${r.counts.problems} 行（见告警）` : ''}`);
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(0); }
  };

  const exportSheet = async () => {
    setError(''); setMsg(''); setBusy(-1);
    try {
      const r = await api.exportSheet();
      setMsg(`已导出 ${r.rows} 个库的当前状态（含包名）到 ${r.file}（不会改动你维护的那份表）`);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(0); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>库管理</div>
          <div className="page-desc">
            三方库的接入信息与<b>包名（bundleName）</b>维护 · 共 {total} 个库
            {missingPkg > 0 && <span style={{ color: 'var(--amber)' }}> · {missingPkg} 个未填包名（真机遍历前必须补齐）</span>}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span className="link" onClick={() => void exportSheet()}>导出库状态</span>
        {' · '}
        <span className="link" onClick={() => void previewSheet()}>{busy === -1 ? '读取中…' : '从表同步'}</span>
        {' · '}
        <button className="btn primary" onClick={openNew}>＋ 新增库</button>
      </div>

      {sheet && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          三方库测试表：<span className="mono">{sheet.file}</span>
          {sheet.exists ? '' : <span style={{ color: 'var(--amber)' }}>（文件不存在，请在「系统配置」里设置 libraries.xlsxPath）</span>}
        </div>
      )}

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {preview && (
        <div className="card" style={{ borderColor: 'var(--accent-dim)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <b>同步预览</b>
            <span className="muted" style={{ fontSize: 12 }}>
              表里解析出 {preview.total} 个库
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn primary sm" onClick={() => void applySheet()} disabled={busy === -1}>
              确认写入（新增 {preview.counts.added} / 更新 {preview.counts.updated}）
            </button>
            <button className="btn sm" onClick={() => setPreview(null)}>取消</button>
          </div>
          <div className="muted" style={{ fontSize: 11.8, marginBottom: 10 }}>
            只写「库名 / 仓库地址 / 子目录」三列。各库的<b>包名与入口 Ability 属于 Agent 维护的事实，不会被同步改动</b>；
            库里有、表里没有的库只报告不删除（删库会级联删用例与执行历史）。
          </div>

          {[
            { key: 'added', label: '新增库', items: preview.plan.added.map((a) => `${a.name} ← 第 ${a.row} 行 · ${a.repoSubpath || '（仓库根）'}`) },
            { key: 'updated', label: '更新仓库地址', items: preview.plan.updated.map((u) => `${u.name} ← 第 ${u.row} 行 · ${u.from.repoSubpath || '（仓库根）'} → ${u.to.repoSubpath || '（仓库根）'}`) },
            { key: 'unchanged', label: '无变化', items: preview.plan.unchanged.map((u) => u.name) },
            { key: 'dbOnly', label: '库中有、表中无（不删除）', items: preview.plan.dbOnly.map((d) => `${d.name}${d.caseCount ? `（已有用例 ${d.caseCount}）` : ''}`) },
            { key: 'problems', label: '表中跳过的问题行（需回表修正）', items: preview.plan.problems.map((p) => `第 ${p.row} 行${p.name ? `「${p.name}」` : ''}：${p.reason}`) },
          ].filter((g) => g.items.length > 0).map((g) => (
            <div key={g.key} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, marginBottom: 3 }}>
                <span className={`tag ${g.key === 'problems' ? 'amber' : g.key === 'added' ? 'green' : g.key === 'dbOnly' ? 'gray' : 'blue'}`}>
                  {g.label} {g.items.length}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 11.3, maxHeight: 120, overflowY: 'auto', color: 'var(--text2)' }}>
                {g.items.slice(0, 60).map((s, i) => <div key={i}>{s}</div>)}
                {g.items.length > 60 && <div className="muted">… 其余 {g.items.length - 60} 条</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div className="search-wrap">
            <span className="ic">🔍</span>
            <input className="input" placeholder="搜索库名 / 描述" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn sm" onClick={() => load()}>刷新</button>
        </div>

        {loading ? (
          <div className="loading">加载中…</div>
        ) : libs.length === 0 ? (
          <div className="loading">没有匹配的库{q ? `（关键词：${q}）` : ''}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>库名</th>
                <th style={{ width: 250 }}>包名（bundleName）</th>
                <th style={{ width: 130 }}>入口 Ability</th>
                <th>仓库地址 / 子目录</th>
                <th style={{ width: 70 }}>用例</th>
                <th style={{ width: 90 }}>同步</th>
                <th style={{ width: 190 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {libs.map((l) => {
                const pkg = (l.packageName ?? '').trim();
                return (
                  <tr key={l.id}>
                    <td className="mono">{l.name}</td>
                    <td className="mono" style={{ fontSize: 11.8 }}>
                      {pkg
                        ? <span style={{ color: 'var(--green)' }}>{pkg}</span>
                        : <span className="tag amber">未填写</span>}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{l.mainAbility || <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 11.2, wordBreak: 'break-all' }}>
                      {l.repoUrl || '—'}
                      {(l.repoSubpath ?? '').trim() && (
                        <div style={{ marginTop: 3 }}>
                          <span className="tag blue">子目录 {(l.repoSubpath ?? '').trim()}</span>
                        </div>
                      )}
                    </td>
                    <td>{l.caseCount ?? 0}</td>
                    <td>{l.lastSyncedAt ? <span className="tag green">已同步</span> : <span className="tag gray">未同步</span>}</td>
                    <td>
                      <span className="link" onClick={() => void detect(l)}>
                        {busy === l.id ? '识别中…' : '识别包名'}
                      </span>
                      {' · '}
                      <span className="link" onClick={() => openEdit(l)}>编辑</span>
                      {' · '}
                      <span className="link" style={{ color: 'var(--red)' }} onClick={() => void remove(l)}>删除</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing !== null && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="drawer" style={{ maxWidth: 560 }}>
            <div className="drawer-h">
              <b>{editing === 'new' ? '新增三方库' : `编辑「${(editing as Library).name}」`}</b>
              <span className="x" onClick={() => setEditing(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>库名 *</span>
                <input className="input" value={form.name} placeholder="如 json-schema" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>包名 bundleName</span>
                <input className="input mono" value={form.packageName} placeholder="如 com.openharmony.jsonschemavalidator"
                  onChange={(e) => setForm({ ...form, packageName: e.target.value })} />
                <span className="muted" style={{ fontSize: 11 }}>
                  真机遍历/执行靠它拉起应用。留空时可用列表里的「识别包名」从设备已安装应用中自动匹配。
                </span>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>入口 Ability</span>
                <input className="input mono" value={form.mainAbility} placeholder="如 EntryAbility（留空也能启动）"
                  onChange={(e) => setForm({ ...form, mainAbility: e.target.value })} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>仓库地址</span>
                <input className="input mono" value={form.repoUrl} placeholder="https://gitcode.com/owner/repo"
                  onChange={(e) => onRepoUrlChange(e.target.value)} />
                <span className="muted" style={{ fontSize: 11 }}>
                  单体仓可以直接粘贴带 <code>/tree/&lt;分支&gt;/&lt;子目录&gt;</code> 的地址，子目录会自动填到下面一栏。
                </span>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>仓库内子目录</span>
                <input className="input mono" value={form.repoSubpath} placeholder="留空表示库就是整个仓库"
                  onChange={(e) => setForm({ ...form, repoSubpath: e.target.value })} />
                <span className="muted" style={{ fontSize: 11 }}>
                  单体仓（如 openharmony_tpc_samples）里同一个仓库有几百个库，必须填清楚子目录：
                  否则解析不到包名，而且每个库都会把整个仓库克隆一份。
                </span>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
                <span className="muted" style={{ fontSize: 12 }}>库简介</span>
                <textarea className="input" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => void save()}>保存</button>
                <button className="btn" onClick={() => setEditing(null)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {candidates && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setCandidates(null); }}>
          <div className="drawer" style={{ maxWidth: 520 }}>
            <div className="drawer-h">
              <b>「{candidates.lib.name}」候选应用（{candidates.items.length}）</b>
              <span className="x" onClick={() => setCandidates(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <p className="muted" style={{ fontSize: 12 }}>设备上匹配到多个应用，请选择正确的那个：</p>
              {candidates.items.map((c) => (
                <div key={c.bundleName} className="card" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="mono" style={{ fontSize: 12, flex: 1, wordBreak: 'break-all' }}>{c.bundleName}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{c.mainAbility || '—'}</span>
                  <button className="btn sm primary" onClick={() => void useCandidate(c.bundleName, c.mainAbility)}>使用</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
