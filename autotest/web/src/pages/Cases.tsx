import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CaseSource, CaseVersion, Library, Page, TestCase } from 'shared';
import { api } from '../api';

const SOURCE_COLORS: Record<string, string> = { 老库存量: 'gray', 新需求引入: 'blue', 问题单跟踪: 'amber', 'AI 生成': 'purple', 真机遍历: 'green' };
const STATUS_COLORS: Record<string, string> = { 通过: 'green', 失败: 'red', 待确认: 'gray', 未执行: 'gray' };
const PAGE_SIZES = [30, 50, 100];

/** 版本说明渲染：【AI优化】前缀显示为蓝色徽标（AI 迭代标识）。 */
function renderChangeNote(note: string | null): React.ReactNode {
  const n = note || '（无更新说明）';
  if (n.startsWith('【AI优化】')) {
    return (
      <>
        <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>【AI优化】</span>
        {n.slice('【AI优化】'.length)}
      </>
    );
  }
  return n;
}

export default function CasesPage({ me }: { me?: { permissions?: string[] } | null } = {}) {
  // case:delete 权限缺失（工程师/访客）时隐藏删除入口，避免 403 困惑
  const canDelete = me?.permissions ? me.permissions.includes('case:delete') : true;
  const [libs, setLibs] = useState<Page<Library> | null>(null);
  const [libQ, setLibQ] = useState('');
  const [curLib, setCurLib] = useState<number | null>(null);
  const [cases, setCases] = useState<Page<TestCase> | null>(null);
  const [source, setSource] = useState('');
  const [caseQ, setCaseQ] = useState('');
  const [error, setError] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [casePage, setCasePage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  // 多选批量操作（跨页保留勾选，切库/切来源时清空）
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  // 版本抽屉
  const [drawer, setDrawer] = useState<{ case: TestCase; versions: CaseVersion[] } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null);
  const [detail, setDetail] = useState<TestCase | null>(null);
  const [caseForm, setCaseForm] = useState<null | { mode: 'create' } | { mode: 'edit'; case: TestCase }>(null);
  const [savingCase, setSavingCase] = useState(false);
  // 真机遍历覆盖报告
  const [sumOpen, setSumOpen] = useState(false);
  const [sumData, setSumData] = useState<Awaited<ReturnType<typeof api.exploreSummary>> | null>(null);
  const [sumExpanded, setSumExpanded] = useState<string | null>(null);
  const [sumLoading, setSumLoading] = useState(false);

  const openSummary = async () => {
    if (curLib === null) return;
    setSumOpen(true);
    setSumLoading(true);
    setSumData(null);
    try {
      setSumData(await api.exploreSummary(curLib));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSumLoading(false);
    }
  };

  // 行内操作：转脚本 / AI优化（按用例 id 标记 busy）
  const [rowBusy, setRowBusy] = useState<{ id: number; kind: 'script' | 'optimize' } | null>(null);

  const caseToScript = async (c: TestCase): Promise<void> => {
    if (curLib === null) return;
    setRowBusy({ id: c.id, kind: 'script' });
    setError('');
    try {
      const r = await api.caseToScript(c.id);
      setImportMsg(`✓ ${c.caseNo} 已绑定 Python 脚本：${r.file}`);
      loadCases(curLib, casePage);
    } catch (e) { setError(String((e as Error).message)); } finally { setRowBusy(null); }
  };

  const optimizeCase = async (c: TestCase): Promise<void> => {
    if (curLib === null) return;
    setRowBusy({ id: c.id, kind: 'optimize' });
    setError('');
    try {
      const r = await api.optimizeCase(c.id);
      flashOptimize(r);
      loadCases(curLib, casePage);
    } catch (e) { setError(String((e as Error).message)); } finally { setRowBusy(null); }
  };

  // AI 优化完成提示（3.5s 自动消失）
  const [optMsg, setOptMsg] = useState('');
  const flashOptimize = (r: { caseNo: string; version: number }): void => {
    setOptMsg(`✓ ${r.caseNo} 已由「用例优化 Agent」优化并迭代到 V${r.version}（版本说明带【AI优化】标识）`);
    setTimeout(() => setOptMsg(''), 3500);
  };

  const toggleSel = (id: number): void => {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const allPageSelected = !!cases && cases.items.length > 0 && cases.items.every((c) => sel.has(c.id));
  const toggleAllPage = (): void => {
    if (!cases) return;
    setSel((s) => {
      const n = new Set(s);
      if (allPageSelected) cases.items.forEach((c) => n.delete(c.id));
      else cases.items.forEach((c) => n.add(c.id));
      return n;
    });
  };

  const batchDelete = async (): Promise<void> => {
    if (curLib === null || sel.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${sel.size} 条用例？版本历史与执行记录将一并删除。`)) return;
    setBatchBusy(true);
    setError('');
    try {
      await api.batchDeleteCases([...sel]);
      setSel(new Set());
      loadCases(curLib, 1);
      api.libraries({ pageSize: 100 }).then(setLibs).catch(() => {});
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBatchBusy(false);
    }
  };

  const batchStatus = async (status: string): Promise<void> => {
    if (curLib === null || sel.size === 0) return;
    setBatchBusy(true);
    setError('');
    try {
      const r = await api.batchUpdateCaseStatus([...sel], status);
      setImportMsg(`批量状态更新：${r.updated} 条 → ${status}`);
      setSel(new Set());
      loadCases(curLib, casePage);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBatchBusy(false);
    }
  };

  const changePageSize = (n: number): void => {
    setPageSize(n);
    setCasePage(1);
    setSel(new Set());
  };

  const loadCases = useCallback((libraryId: number, page: number) => {
    api.cases(libraryId, { page, pageSize, source: source || undefined, q: caseQ || undefined })
      .then((r) => { setCases(r); setCasePage(r.page); })
      .catch((e) => setError(String(e.message)));
  }, [source, caseQ, pageSize]);

  useEffect(() => {
    api.libraries({ pageSize: 100 })
      .then((r) => {
        setLibs(r);
        if (r.items.length > 0 && curLib === null) setCurLib(r.items[0].id);
      })
      .catch((e) => setError(String(e.message)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 切库/来源/搜索词变化时清空勾选
  useEffect(() => { setSel(new Set()); }, [curLib, source, caseQ]);

  useEffect(() => {
    if (curLib !== null) loadCases(curLib, casePage);
  }, [curLib, casePage, loadCases]);

  const openDrawer = (c: TestCase) => {
    setDrawerLoading(true);
    setDrawer({ case: c, versions: [] });
    setCompare(null);
    api.caseVersions(c.id)
      .then((vs) => setDrawer({ case: c, versions: vs }))
      .catch((e) => setError(String(e.message)))
      .finally(() => setDrawerLoading(false));
  };

  const rollback = async (v: number) => {
    if (!drawer) return;
    try {
      await api.rollbackCase(drawer.case.id, v);
      const [fresh, vs] = await Promise.all([api.caseDetail(drawer.case.id), api.caseVersions(drawer.case.id)]);
      setDrawer({ case: fresh, versions: vs });
      if (curLib !== null) loadCases(curLib, casePage);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const deleteCase = async (c: TestCase) => {
    if (!window.confirm(`确认删除用例 ${c.caseNo}（${c.name}）？版本历史与执行记录将一并删除。`)) return;
    try {
      await api.deleteCase(c.id);
      if (curLib !== null) loadCases(curLib, casePage);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const saveCaseForm = async (form: { caseNo: string; name: string; source: string; precondition: string; steps: string; expected: string; dtsUrl: string }) => {
    if (curLib === null) return;
    setSavingCase(true);
    setError('');
    try {
      const body = {
        caseNo: form.caseNo.trim(),
        name: form.name.trim(),
        source: form.source as CaseSource,
        precondition: form.precondition.trim(),
        steps: form.steps.split('\n').map((s) => s.trim()).filter(Boolean),
        expected: form.expected.trim(),
        dtsUrl: form.dtsUrl.trim(),
      };
      if (caseForm?.mode === 'edit') {
        await api.updateCase(caseForm.case.id, { ...body, changeNote: '人工编辑：手动修改用例内容。', author: '测试工程师', authorType: 'human' });
      } else {
        await api.createCase({ libraryId: curLib, ...body });
      }
      setCaseForm(null);
      loadCases(curLib, casePage);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSavingCase(false);
    }
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        resolve(btoa(bin));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });

  const onImportFile = async (file: File | undefined) => {
    if (!file || curLib === null) return;
    setError('');
    setImportMsg('导入中…');
    try {
      const base64 = await fileToBase64(file);
      const r = await api.importCases(curLib, file.name, base64);
      setImportMsg(`导入完成：新增 ${r.imported} 条${r.skipped ? `，跳过 ${r.skipped} 条` : ''}${r.errors.length ? `，错误 ${r.errors.length} 条` : ''}`);
      loadCases(curLib, casePage);
      api.libraries({ pageSize: 100 }).then(setLibs).catch(() => {});
    } catch (e) {
      setImportMsg('');
      setError(String((e as Error).message));
    }
  };

  const onExport = async () => {
    if (curLib === null) return;
    try {
      const blob = await api.exportCases(curLib);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const lib = libs?.items.find((l) => l.id === curLib);
      a.download = `${lib?.name ?? curLib}-用例.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const filteredLibs = libs ? libs.items.filter((l) => l.name.toLowerCase().includes(libQ.toLowerCase())) : [];

  return (
    <>
      <div className="page-title">测试用例</div>
      <div className="page-desc">
        版本按单条用例迭代（每次更新自动递增，可单独回滚）· 来源分类（新需求 / 存量 / 问题单）· Excel 导入导出
      </div>

      {error && <div className="error">⚠️ {error}</div>}

      <div className="grid" style={{ gridTemplateColumns: '230px 1fr' }}>
        {/* 库列表 */}
        <div className="card" style={{ padding: 12 }}>
          <div className="card-h" style={{ marginBottom: 8 }}>
            <span className="t">三方库列表</span>
            <span className="sub">{libs?.total ?? '…'} 个</span>
          </div>
          <div className="search-wrap" style={{ maxWidth: 'none', marginBottom: 8 }}>
            <span className="ic">🔍</span>
            <input className="input" placeholder="搜索三方库…" value={libQ} onChange={(e) => setLibQ(e.target.value)} />
          </div>
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {filteredLibs.map((l) => (
              <div
                key={l.id}
                className={`nav-item ${curLib === l.id ? 'active' : ''}`}
                style={{ margin: 0, borderRadius: 7 }}
                onClick={() => { setCasePage(1); setCurLib(l.id); }}
              >
                <span className="ico">📦</span>
                {l.name}
                <span className="badge">{l.caseCount ?? 0}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 用例表 */}
        <div className="card" style={{ padding: '12px 0 6px' }}>
          <div style={{ padding: '0 14px', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="search-wrap" style={{ maxWidth: 260 }}>
              <span className="ic">🔍</span>
              <input className="input" placeholder="搜索用例…" value={caseQ} onChange={(e) => setCaseQ(e.target.value)} />
            </div>
            <select className="select" style={{ width: 140 }} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">全部来源</option>
              <option>新需求引入</option>
              <option>老库存量</option>
              <option>问题单跟踪</option>
              <option>AI 生成</option>
              <option>真机遍历</option>
            </select>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            <button className="btn sm" disabled={curLib === null} onClick={onExport}>⬇ 导出 Excel</button>
            <button className="btn sm" disabled={curLib === null} onClick={() => fileRef.current?.click()}>⬆ 导入 Excel</button>
            <button className="btn sm primary" disabled={curLib === null} onClick={() => setCaseForm({ mode: 'create' })}>＋ 新增用例</button>
            <button className="btn sm" disabled={curLib === null} onClick={() => void openSummary()} title="最近一次真机遍历的页面级覆盖报告">📡 遍历报告</button>
            {importMsg && <span className="muted" style={{ fontSize: 11.5 }}>{importMsg}</span>}
            {optMsg && <span className="tag blue" style={{ fontSize: 11.5 }}>{optMsg}</span>}
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
              版本按单条用例迭代 · 更新自动递增 · 可单独回滚
            </span>
          </div>

          {/* 批量操作条 */}
          {sel.size > 0 && (
            <div style={{
              margin: '0 14px 10px', padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 9, fontSize: 12.3,
            }}>
              <b>已选 {sel.size} 条</b>
              <span className="muted" style={{ fontSize: 11.5 }}>批量状态：</span>
              {(['通过', '失败', '待确认', '未执行'] as const).map((st) => (
                <button key={st} className="btn sm" disabled={batchBusy} onClick={() => void batchStatus(st)}>{st}</button>
              ))}
              {canDelete && <button className="btn sm" style={{ color: 'var(--red)' }} disabled={batchBusy} onClick={() => void batchDelete()}>🗑 批量删除</button>}
              <button className="btn sm ghost" onClick={() => setSel(new Set())}>取消选择</button>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            {!cases ? (
              <div className="loading">加载中…</div>
            ) : (
              <table>
                <tr>
                  <th style={{ width: 34 }}>
                    <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} title="全选本页" style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                  </th>
                  <th>用例 ID</th><th>用例名称</th><th>来源</th><th>版本</th><th>状态</th><th>脚本</th><th>问题单</th><th>操作</th>
                </tr>
                {cases.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggleSel(c.id)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                    </td>
                    <td className="mono">{c.caseNo}</td>
                    <td>
                      <span className="link" onClick={() => setDetail(c)}>{c.name}</span>
                    </td>
                    <td><span className={`tag ${SOURCE_COLORS[c.source] ?? 'gray'}`}>{c.source}</span></td>
                    <td><span className="tag plain">V{c.currentVersion}</span></td>
                    <td><span className={`tag ${STATUS_COLORS[c.status] ?? 'gray'}`}>{c.status}</span></td>
                    <td>
                      {c.scriptStatus === '已绑定'
                        ? <span className="tag cyan">已绑定</span>
                        : <span className="tag gray">未绑定</span>}
                    </td>
                    <td>
                      {c.dtsUrl
                        ? <a className="link" href={c.dtsUrl} target="_blank" rel="noreferrer" title={c.dtsUrl}>DTS 单 ↗</a>
                        : <span className="muted">—</span>}
                    </td>
                    <td>
                      <span className="link" onClick={() => setCaseForm({ mode: 'edit', case: c })}>编辑</span>
                      <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                      <span className="link" onClick={() => openDrawer(c)}>版本历史</span>
                      <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                      {rowBusy?.id === c.id && rowBusy.kind === 'script'
                        ? <span className="muted">转脚本中…</span>
                        : <span className="link" title="生成并绑定 Python/Hypium 自动化脚本（执行计划直接运行）" onClick={() => void caseToScript(c)}>⚙ 转脚本</span>}
                      <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                      {rowBusy?.id === c.id && rowBusy.kind === 'optimize'
                        ? <span className="muted">AI 优化中…</span>
                        : <span className="link" style={{ color: 'var(--accent2)' }} title="用例优化 Agent：保持测试意图，提升真实性与可验证性，版本自动迭代并标注【AI优化】" onClick={() => void optimizeCase(c)}>✨ AI优化</span>}
                      {canDelete && (
                        <>
                          <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                          <span className="link" style={{ color: 'var(--red)' }} onClick={() => void deleteCase(c)}>删除</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </table>
            )}
          </div>
          {cases && (
            (() => {
              const totalPages = Math.max(1, Math.ceil(cases.total / cases.pageSize));
              const win = 5;
              let from = Math.max(1, (cases.page ?? 1) - Math.floor(win / 2));
              let to = Math.min(totalPages, from + win - 1);
              from = Math.max(1, to - win + 1);
              const pages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
              const go = (p: number) => { if (curLib !== null && p >= 1 && p <= totalPages) loadCases(curLib, p); };
              return (
                <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text3)', flexWrap: 'wrap' }}>
                  <span>共 {cases.total} 条 · 第 {cases.page} / {totalPages} 页</span>
                  <select
                    className="select"
                    style={{ width: 92, padding: '3px 8px', fontSize: 11.5 }}
                    value={pageSize}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                    title="每页条数"
                  >
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} 条/页</option>)}
                  </select>
                  <div style={{ flex: 1 }} />
                  <button className="btn sm" disabled={cases.page <= 1} onClick={() => go(1)}>« 首页</button>
                  <button className="btn sm" disabled={cases.page <= 1} onClick={() => go(cases.page - 1)}>‹ 上一页</button>
                  {pages.map((p) => (
                    <button key={p} className={`btn sm ${p === cases.page ? 'primary' : ''}`} onClick={() => go(p)}>{p}</button>
                  ))}
                  <button className="btn sm" disabled={cases.page >= totalPages} onClick={() => go(cases.page + 1)}>下一页 ›</button>
                  <button className="btn sm" disabled={cases.page >= totalPages} onClick={() => go(totalPages)}>末页 »</button>
                </div>
              );
            })()
          )}
        </div>
      </div>

      {/* 用例详情抽屉 */}
      {detail && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="drawer">
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>{detail.caseNo} · 用例详情</span>
              <span className="x" onClick={() => setDetail(null)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h">
                  <span className="t">{detail.name}</span>
                  <span className={`tag ${SOURCE_COLORS[detail.source] ?? 'gray'}`}>{detail.source}</span>
                  <span className={`tag ${STATUS_COLORS[detail.status] ?? 'gray'}`}>{detail.status}</span>
                  <span className="tag plain">V{detail.currentVersion}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.8 }}>
                  脚本：{detail.scriptStatus}
                  {detail.dtsUrl && <> · <a className="link" href={detail.dtsUrl} target="_blank" rel="noreferrer" title={detail.dtsUrl}>DTS 单 ↗</a></>}
                </div>
              </div>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><span className="t">预置条件</span></div>
                <div style={{ fontSize: 12.8, color: 'var(--text2)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{detail.precondition || '（无）'}</div>
              </div>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><span className="t">操作步骤</span></div>
                {detail.steps.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12.5 }}>（无步骤）</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {detail.steps.map((s, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.8, color: 'var(--text2)', lineHeight: 1.6 }}>
                        <span className="mono" style={{ color: 'var(--text3)', fontSize: 11.5, width: 26, textAlign: 'right', flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                        <span>{String(s)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><span className="t">预期结果</span></div>
                <div style={{ fontSize: 12.8, color: 'var(--text2)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{detail.expected || '（无）'}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={() => { const c = detail; setDetail(null); openDrawer(c); }}>版本历史</button>
                <button className="btn sm primary" onClick={() => { const c = detail; setDetail(null); setCaseForm({ mode: 'edit', case: c }); }}>编辑</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 版本历史抽屉 */}
      <div className={`drawer-mask ${drawer ? 'show' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setDrawer(null); }}>
        <div className="drawer">
          <div className="drawer-h">
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>
              {drawer?.case.caseNo} · 版本历史
            </span>
            <span className="x" onClick={() => setDrawer(null)}>✕</span>
          </div>
          <div className="drawer-b">
            {drawer && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-h">
                  <span className="t">{drawer.case.name}</span>
                  <span className={`tag ${SOURCE_COLORS[drawer.case.source] ?? 'gray'}`}>{drawer.case.source}</span>
                  <span className="tag green">当前 V{drawer.case.currentVersion}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
                  版本按单条用例迭代：<b style={{ color: 'var(--accent2)' }}>每次更新自动递增（V1→V2→V3…，无上限）</b>，回滚也会产生新版本记录，时间线完整可审计。
                </div>
              </div>
            )}
            {drawerLoading && <div className="loading">加载版本历史…</div>}
            {drawer && !drawerLoading && (
              <>
                {compare && drawer.versions.length > 0 && (() => {
                  const a = drawer.versions.find((v) => v.version === compare.from);
                  const b = drawer.versions.find((v) => v.version === compare.to);
                  const rows: Array<{ field: string; old: string; neu: string }> = [];
                  if (a && b) {
                    const sa = a.snapshot;
                    const sb = b.snapshot;
                    const fields: Array<[keyof typeof sa, string]> = [
                      ['name', '用例名称'], ['source', '来源'], ['precondition', '前置条件'],
                      ['steps', '操作步骤'], ['expected', '预期结果'], ['status', '状态'], ['scriptStatus', '脚本状态'],
                    ];
                    for (const [k, label] of fields) {
                      const va = sa[k]; const vb = sb[k];
                      if (JSON.stringify(va) !== JSON.stringify(vb)) {
                        rows.push({ field: label, old: Array.isArray(va) ? (va as string[]).join('\n') : String(va ?? '—'), neu: Array.isArray(vb) ? (vb as string[]).join('\n') : String(vb ?? '—') });
                      }
                  }
                  return (
                    <div className="card" style={{ marginBottom: 16 }}>
                      <div className="card-h">
                        <span className="t">版本对比</span>
                        <span className="sub">V{compare.from} → V{compare.to} 变更字段</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select className="select" value={compare.from} onChange={(e) => setCompare({ ...compare, from: Number(e.target.value) })}>
                            {drawer.versions.map((v) => <option key={v.version} value={v.version}>V{v.version}</option>)}
                          </select>
                          <span className="muted">→</span>
                          <select className="select" value={compare.to} onChange={(e) => setCompare({ ...compare, to: Number(e.target.value) })}>
                            {drawer.versions.map((v) => <option key={v.version} value={v.version}>V{v.version}</option>)}
                          </select>
                          <button className="btn sm" onClick={() => setCompare(null)}>返回时间线</button>
                        </div>
                      </div>
                      {rows.length === 0 ? (
                        <div className="muted" style={{ fontSize: 12.5, padding: '6px 2px' }}>两个版本内容一致，无差异字段。</div>
                      ) : (
                        <table>
                          <thead><tr><th>字段</th><th style={{ width: '42%' }}>V{compare.from}</th><th style={{ width: '42%' }}>V{compare.to}</th></tr></thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.field}>
                                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{r.field}</td>
                                <td style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{r.old}</td>
                                <td style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--accent2)' }}>{r.neu}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                }
                })()}
                <div className="ver-timeline">
                  {drawer.versions.map((v) => (
                    <div key={v.version} className="ver-item">
                      <span className={`ver-dot ${v.version === drawer.case.currentVersion ? 'current' : ''}`} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>V{v.version}</span>
                        {v.version === drawer.case.currentVersion
                          ? <span className="tag green">当前版本</span>
                          : <span className="tag gray">历史版本</span>}
                      </div>
                      <div className="vd">{v.createdAt} · {v.author} · {v.authorType === 'ai' ? 'AI' : '人工'}</div>
                      <div className="vc">
                        {renderChangeNote(v.changeNote)}
                      </div>
                      <div className="va">
                        <button className="btn sm" onClick={() => rollback(v.version)}>↩ 回滚到此版本</button>
                        <button className="btn sm" onClick={() => setCompare({ from: v.version, to: drawer.case.currentVersion })}>对比</button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {caseForm && (
        <CaseFormModal
          mode={caseForm.mode}
          initial={caseForm.mode === 'edit' ? caseForm.case : undefined}
          saving={savingCase}
          onClose={() => setCaseForm(null)}
          onSave={(f) => void saveCaseForm(f)}
        />
      )}

      {sumOpen && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setSumOpen(false)} />
          <div style={{ position: 'relative', zIndex: 1, width: 880, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>📡 真机遍历 · 页面级覆盖报告</span>
              {sumData?.stats && <span className="muted" style={{ fontSize: 12 }}>{sumData.stats.generatedAt}</span>}
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setSumOpen(false)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px' }}>
              {sumLoading && <div className="loading">加载覆盖报告…</div>}
              {!sumLoading && !sumData?.stats && (
                <div className="muted" style={{ fontSize: 12.5, padding: 24, textAlign: 'center' }}>
                  该库暂无遍历报告。在任务页发起「真机遍历生成用例」任务，完成后这里会展示页面级覆盖情况。
                </div>
              )}
              {!sumLoading && sumData?.stats && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
                    {([
                      ['页面数', sumData.stats.totalPages],
                      ['富页面', sumData.stats.richPages],
                      ['动画页', sumData.stats.animationPages],
                      ['越界适配', sumData.stats.swipeAdjustedPages],
                      ['生成用例', sumData.stats.totalCases],
                      ['绑定脚本', sumData.stats.scriptBound],
                      ['页面覆盖', `${sumData.stats.coverage}%`],
                      ['脚本覆盖', `${sumData.stats.scriptCoverage}%`],
                    ] as Array<[string, string | number]>).map(([label, v]) => (
                      <div key={label} className="card" style={{ padding: '10px 12px', textAlign: 'center' }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent2)' }}>{v}</div>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  <table style={{ width: '100%', fontSize: 12.5 }}>
                    <thead>
                      <tr>
                        <th>页面路径</th>
                        <th>控件</th>
                        <th>动画</th>
                        <th>滑动</th>
                        <th>用例</th>
                        <th>脚本</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sumData.pages.map((p) => (
                        <Fragment key={p.pathStr}>
                          <tr style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }} onClick={() => setSumExpanded(sumExpanded === p.pathStr ? null : p.pathStr)}>
                            <td style={{ padding: '7px 4px' }}>{p.pathStr}</td>
                            <td>{p.controlCount}</td>
                            <td>{p.animation ? '🟢' : '—'}</td>
                            <td>{p.swipes > 0 ? `${p.swipes} 次` : '—'}</td>
                            <td>{p.caseCount}</td>
                            <td>{p.scriptBound}/{p.caseCount}</td>
                            <td className="muted">{p.note}</td>
                          </tr>
                          {sumExpanded === p.pathStr && (
                            <tr>
                              <td colSpan={7} style={{ padding: '10px 12px', background: 'var(--bg2)', borderRadius: 8 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                                  <div>
                                    <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>关联用例（{p.caseCount}）</div>
                                    {p.cases.length === 0 && <span className="muted" style={{ fontSize: 11.5 }}>该页尚未生成用例</span>}
                                    {p.cases.map((c) => (
                                      <div key={c.caseId} style={{ fontSize: 11.8, marginBottom: 3 }}>
                                        <span className="mono" style={{ color: 'var(--accent2)' }}>{c.caseNo}</span>{' '}
                                        {c.name}
                                        <span className={`tag ${c.scriptStatus === '已绑定' ? 'green' : 'gray'}`} style={{ marginLeft: 6 }}>{c.scriptStatus}</span>
                                      </div>
                                    ))}
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>状态</div>
                                    <div className="muted" style={{ fontSize: 11.8, lineHeight: 1.7 }}>{p.note}</div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CaseFormModal(props: {
  mode: 'create' | 'edit';
  initial?: TestCase;
  saving: boolean;
  onClose: () => void;
  onSave: (f: { caseNo: string; name: string; source: string; precondition: string; steps: string; expected: string; dtsUrl: string }) => void;
}) {
  const c = props.initial;
  const [form, setForm] = useState(() => ({
    caseNo: c?.caseNo ?? `C-MAN-${Date.now().toString().slice(-6)}`,
    name: c?.name ?? '',
    source: c?.source ?? '新需求引入',
    precondition: c?.precondition ?? '',
    steps: (c?.steps ?? []).join('\n'),
    expected: c?.expected ?? '',
    dtsUrl: c?.dtsUrl ?? '',
  }));
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const input: CSSProperties = { width: '100%' };
  return (
    <div className="s-overlay show">
      <div className="s-mask" onClick={props.onClose} />
      <div style={{ position: 'relative', zIndex: 1, width: 720, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{props.mode === 'create' ? '＋ 新增用例' : `编辑用例 ${c?.caseNo}`}</span>
          <div style={{ flex: 1 }} />
          <button className="s-header x" onClick={props.onClose} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
        <div style={{ padding: '18px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span className="muted" style={{ fontSize: 12 }}>用例编号</span>
              <input className="input mono" style={input} value={form.caseNo} onChange={(e) => set('caseNo', e.target.value)} />
            </label>
            <label style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span className="muted" style={{ fontSize: 12 }}>用例名称 *</span>
              <input className="input" style={input} value={form.name} onChange={(e) => set('name', e.target.value)} />
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>来源</span>
            <select className="select" value={form.source} onChange={(e) => set('source', e.target.value)}>
              <option>新需求引入</option>
              <option>老库存量</option>
              <option>问题单跟踪</option>
              <option>AI 生成</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>前置条件</span>
            <input className="input" style={input} value={form.precondition} onChange={(e) => set('precondition', e.target.value)} placeholder="如：应用已安装，已登录" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>操作步骤（每行一步）</span>
            <textarea className="input" style={{ ...input, minHeight: 110, resize: 'vertical', lineHeight: 1.6 }} value={form.steps}
              onChange={(e) => set('steps', e.target.value)} placeholder={'打开应用主界面\n点击「xxx」按钮\n等待 2 秒\n验证「xxx」文本显示'} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>预期结果</span>
            <textarea className="input" style={{ ...input, minHeight: 70, resize: 'vertical', lineHeight: 1.6 }} value={form.expected}
              onChange={(e) => set('expected', e.target.value)} placeholder="界面显示 xxx 动画 / 打印日志 xxx" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>问题单链接（DTS，可空）</span>
            <input className="input mono" style={input} value={form.dtsUrl} onChange={(e) => set('dtsUrl', e.target.value)} placeholder="https://dts.xxx/issue/12345" />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={props.onClose}>取消</button>
            <button className="btn primary" disabled={props.saving || !form.name.trim()} onClick={() => props.onSave(form)}>
              {props.saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
