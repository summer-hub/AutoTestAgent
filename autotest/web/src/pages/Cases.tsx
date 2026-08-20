import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaseVersion, Library, Page, TestCase } from 'shared';
import { api } from '../api';

const SOURCE_COLORS: Record<string, string> = { 老库存量: 'gray', 新需求引入: 'blue', 问题单跟踪: 'amber', 'AI 生成': 'purple' };
const STATUS_COLORS: Record<string, string> = { 通过: 'green', 失败: 'red', 待确认: 'gray', 未执行: 'gray' };

export default function CasesPage() {
  const [libs, setLibs] = useState<Page<Library> | null>(null);
  const [libQ, setLibQ] = useState('');
  const [curLib, setCurLib] = useState<number | null>(null);
  const [cases, setCases] = useState<Page<TestCase> | null>(null);
  const [source, setSource] = useState('');
  const [caseQ, setCaseQ] = useState('');
  const [error, setError] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // 版本抽屉
  const [drawer, setDrawer] = useState<{ case: TestCase; versions: CaseVersion[] } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const loadCases = useCallback((libraryId: number) => {
    api.cases(libraryId, { pageSize: 50, source: source || undefined, q: caseQ || undefined })
      .then(setCases).catch((e) => setError(String(e.message)));
  }, [source, caseQ]);

  useEffect(() => {
    api.libraries({ pageSize: 100 })
      .then((r) => {
        setLibs(r);
        if (r.items.length > 0 && curLib === null) {
          setCurLib(r.items[0].id);
          api.cases(r.items[0].id, { pageSize: 50 }).then(setCases).catch((e) => setError(String(e.message)));
        }
      })
      .catch((e) => setError(String(e.message)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (curLib !== null) loadCases(curLib);
  }, [curLib, loadCases]);

  const openDrawer = (c: TestCase) => {
    setDrawerLoading(true);
    setDrawer({ case: c, versions: [] });
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
      if (curLib !== null) loadCases(curLib);
    } catch (e) {
      setError(String((e as Error).message));
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
      loadCases(curLib);
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
                onClick={() => setCurLib(l.id)}
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
            {importMsg && <span className="muted" style={{ fontSize: 11.5 }}>{importMsg}</span>}
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
              版本按单条用例迭代 · 更新自动递增 · 可单独回滚
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {!cases ? (
              <div className="loading">加载中…</div>
            ) : (
              <table>
                <tr>
                  <th>用例 ID</th><th>用例名称</th><th>来源</th><th>版本</th><th>状态</th><th>脚本</th><th>操作</th>
                </tr>
                {cases.items.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.caseNo}</td>
                    <td>{c.name}</td>
                    <td><span className={`tag ${SOURCE_COLORS[c.source] ?? 'gray'}`}>{c.source}</span></td>
                    <td><span className="tag plain">V{c.currentVersion}</span></td>
                    <td><span className={`tag ${STATUS_COLORS[c.status] ?? 'gray'}`}>{c.status}</span></td>
                    <td>
                      {c.scriptStatus === '已绑定'
                        ? <span className="tag cyan">已绑定</span>
                        : <span className="tag gray">未绑定</span>}
                    </td>
                    <td>
                      <span className="link" onClick={() => openDrawer(c)}>版本历史</span>
                    </td>
                  </tr>
                ))}
              </table>
            )}
          </div>
          {cases && (
            <div style={{ padding: '10px 14px', fontSize: 11.5, color: 'var(--text3)' }}>
              共 {cases.total} 条 · 第 {cases.page} 页 / 每页 {cases.pageSize} 条（分页组件下一迭代补齐）
            </div>
          )}
        </div>
      </div>

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
                    <div className="vc">{v.changeNote || '（无更新说明）'}</div>
                    <div className="va">
                      <button className="btn sm" onClick={() => rollback(v.version)}>↩ 回滚到此版本</button>
                      {v.version > 1 && <button className="btn sm" onClick={() => window.alert('版本对比：下一迭代实现')}>对比</button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
