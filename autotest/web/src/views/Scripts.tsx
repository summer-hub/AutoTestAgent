import { useCallback, useEffect, useState } from 'react';
import type { RepoFile, RepoFileEntry } from 'shared';
import { api } from '../api';

interface ScriptLib { id: number; name: string; dir: string; exists: boolean; fileCount: number; }

const PAGE_SIZES = [30, 50, 100];

// 新建脚本的初始模板（Python/Hypium，与 HypiumProjectTemplate 一致）
const SCRIPT_TEMPLATE = `# !/usr/bin/env python
# coding: utf-8
"""
#!!================================================================
# AutoTest · Hypium 用例脚本（文件名 = 用例编号，如 C-AI-001.py）
# 执行计划「立即执行」将直接运行本脚本并解析 xdevice 报告回填结果
# 支持动作：driver.touch(BY.text('xx')) / driver.input_text(BY.text(kw), text)
#           driver.swipe(UiParam.UP, distance=60) / driver.wait(2) / driver.swipe_to_back()
#==================================================================
"""

from devicetest.core.test_case import TestCase, Step
from hypium import *
from hypium.model import UiParam


class Case_Template(TestCase):
    def __init__(self, controllers):
        self.TAG = self.__class__.__name__
        TestCase.__init__(self, self.TAG, controllers)
        self.driver = UiDriver(self.device1)

    def setup(self):
        Step('杀掉应用')
        # self.driver.stop_app("com.example.app")
        Step('启动应用')
        # self.driver.start_app(package_name="com.example.app")
        self.driver.wait(3)

    def process(self):
        Step('1. 示例步骤：点击目标按钮')
        self.driver.touch(BY.text("开始"))
        self.driver.wait(1)
        Step('2. 验证结果')
        comp = self.driver.find_component(BY.text("成功"))

    def teardown(self):
        pass
`;

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

export default function ScriptsPage() {
  const [libs, setLibs] = useState<ScriptLib[]>([]);
  const [curLib, setCurLib] = useState<number | null>(null);
  const [scripts, setScripts] = useState<RepoFileEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ libName: string; file: RepoFile } | null>(null);
  // 多选批量删除（客户端分页）
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [batchBusy, setBatchBusy] = useState(false);
  // 新建 / 编辑脚本
  const [editor, setEditor] = useState<null | { mode: 'create' } | { mode: 'edit'; name: string }>(null);
  const [editorName, setEditorName] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorBusy, setEditorBusy] = useState(false);
  // 单脚本真机执行
  const [runningName, setRunningName] = useState('');
  const [runResult, setRunResult] = useState<null | { name: string; status: 'passed' | 'failed'; durationMs: number; log: string }>(null);

  const loadLibs = useCallback(() => {
    api.scripts()
      .then((r) => {
        setLibs(r);
        setCurLib((prev) => prev ?? r.find((l) => l.exists)?.id ?? r[0]?.id ?? null);
      })
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  const loadScripts = useCallback((libId: number) => {
    setLoading(true);
    setError('');
    api.repoFiles(libId, '', 'scripts')
      .then((r) => setScripts(r.entries))
      .catch((e) => { setError(String((e as Error).message)); setScripts(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadLibs(); }, [loadLibs]);
  useEffect(() => { if (curLib !== null) loadScripts(curLib); }, [curLib, loadScripts]);
  // 切库/搜索词变化时重置分页与勾选
  useEffect(() => { setPage(1); setSel(new Set()); }, [curLib, q]);

  const openFile = async (f: RepoFileEntry) => {
    if (curLib === null) return;
    try {
      const file = await api.repoFile(curLib, f.name, 'scripts');
      setDetail({ libName: libs.find((l) => l.id === curLib)?.name ?? '', file });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const removeFile = async (f: RepoFileEntry) => {
    if (curLib === null) return;
    if (!window.confirm(`确认删除脚本文件 ${f.name}？`)) return;
    try {
      await api.deleteScriptFile(curLib, f.name);
      loadScripts(curLib);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const filtered = (scripts ?? []).filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);
  const allPageSelected = pageItems.length > 0 && pageItems.every((s) => sel.has(s.name));

  const toggleSel = (name: string): void => {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
  };

  const toggleAllPage = (): void => {
    setSel((s) => {
      const n = new Set(s);
      if (allPageSelected) pageItems.forEach((x) => n.delete(x.name));
      else pageItems.forEach((x) => n.add(x.name));
      return n;
    });
  };

  const batchDelete = async (): Promise<void> => {
    if (curLib === null || sel.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${sel.size} 个脚本文件？`)) return;
    setBatchBusy(true);
    setError('');
    try {
      for (const name of sel) {
        await api.deleteScriptFile(curLib, name);
      }
      setSel(new Set());
      loadScripts(curLib);
      loadLibs();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBatchBusy(false);
    }
  };

  const openCreate = (): void => {
    setEditor({ mode: 'create' });
    setEditorName(`C-MANUAL-${Date.now().toString().slice(-6)}.py`);
    setEditorContent(SCRIPT_TEMPLATE);
  };

  const openEdit = async (f: RepoFileEntry): Promise<void> => {
    if (curLib === null) return;
    try {
      const file = await api.repoFile(curLib, f.name, 'scripts');
      setEditor({ mode: 'edit', name: f.name });
      setEditorName(f.name);
      setEditorContent(file.content);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (curLib === null || !editor) return;
    const name = editorName.trim();
    if (!/^[^\\/]+\.py$/i.test(name) || name.includes('..')) {
      setError('文件名非法：须为当前目录下的 .py 文件（如 C-AI-001.py）');
      return;
    }
    setEditorBusy(true);
    setError('');
    try {
      await api.saveScriptFile(curLib, name, editorContent);
      setEditor(null);
      loadScripts(curLib);
      loadLibs();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setEditorBusy(false);
    }
  };

  const runOne = async (f: RepoFileEntry): Promise<void> => {
    if (curLib === null) return;
    setRunningName(f.name);
    setError('');
    try {
      const r = await api.runScript(curLib, f.name);
      setRunResult({ name: f.name, status: r.status, durationMs: r.durationMs, log: r.log });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRunningName('');
    }
  };

  const curName = curLib !== null ? libs.find((l) => l.id === curLib)?.name ?? '' : '';

  return (
    <>
      <div className="page-title">自动化脚本</div>
      <div className="page-desc">Python/Hypium 自动化脚本（对齐 HypiumProjectTemplate）· 可单脚本真机执行 · 新建 / 编辑 / 删除</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div className="grid" style={{ gridTemplateColumns: '230px 1fr' }}>
        <div className="card" style={{ padding: 12 }}>
          <div className="card-h" style={{ marginBottom: 8 }}>
            <span className="t">三方库列表</span>
            <span className="sub">{libs.filter((l) => l.exists).length} 个有脚本</span>
          </div>
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {libs.map((l) => (
              <div
                key={l.id}
                className={`nav-item ${curLib === l.id ? 'active' : ''}`}
                style={{ margin: 0, borderRadius: 7 }}
                onClick={() => setCurLib(l.id)}
              >
                <span className="ico">📦</span>
                {l.name}
                <span className="badge">{l.fileCount}</span>
              </div>
            ))}
            {libs.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 10 }}>暂无三方库</div>}
          </div>
        </div>

        <div className="card" style={{ padding: '12px 0 6px' }}>
          <div style={{ padding: '0 14px', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="search-wrap" style={{ maxWidth: 260 }}>
              <span className="ic">🔍</span>
              <input className="input" placeholder="搜索脚本文件…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select
              className="select"
              style={{ width: 92 }}
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              title="每页条数"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} 条/页</option>)}
            </select>
            <button className="btn sm primary" disabled={curLib === null} onClick={openCreate} title="手工新增自动化脚本（.ts），执行计划绑定脚本模式下解析动作步骤真机执行">＋ 新建脚本</button>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
              {curName} · {filtered.length} 个脚本
            </span>
          </div>

          {/* 批量操作条 */}
          {sel.size > 0 && (
            <div style={{
              margin: '0 14px 10px', padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 9, fontSize: 12.3,
            }}>
              <b>已选 {sel.size} 个文件</b>
              <button className="btn sm" style={{ color: 'var(--red)' }} disabled={batchBusy} onClick={() => void batchDelete()}>🗑 批量删除</button>
              <button className="btn sm ghost" onClick={() => setSel(new Set())}>取消选择</button>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div className="loading">加载中…</div>
            ) : !scripts || scripts.length === 0 ? (
              <div className="loading">该库暂无脚本，先在任务页用「用例转自动化脚本」生成</div>
            ) : filtered.length === 0 ? (
              <div className="loading">无匹配脚本</div>
            ) : (
              <>
                <table>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} title="全选本页" style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                    </th>
                    <th>文件</th><th>大小</th><th>修改时间</th><th>操作</th>
                  </tr>
                  {pageItems.map((s) => (
                    <tr key={s.name}>
                      <td>
                        <input type="checkbox" checked={sel.has(s.name)} onChange={() => toggleSel(s.name)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                      </td>
                      <td className="mono">{s.name}</td>
                      <td className="muted">{fmtSize(s.size)}</td>
                      <td className="muted">{new Date(s.mtime).toLocaleString('zh-CN', { hour12: false })}</td>
                      <td>
                        <span className="link" onClick={() => void runOne(s)} title="真机执行该脚本（需设备在线 + Python/xdevice）">
                          {runningName === s.name ? '执行中…' : '▶ 执行'}
                        </span>
                        <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                        <span className="link" onClick={() => void openFile(s)}>查看</span>
                        <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                        <span className="link" onClick={() => void openEdit(s)}>编辑</span>
                        <span style={{ margin: '0 6px', color: 'var(--text3)' }}>·</span>
                        <span className="link" style={{ color: 'var(--red)' }} onClick={() => void removeFile(s)}>删除</span>
                      </td>
                    </tr>
                  ))}
                </table>
                <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text3)', flexWrap: 'wrap' }}>
                  <span>共 {filtered.length} 个 · 第 {curPage} / {totalPages} 页</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn sm" disabled={curPage <= 1} onClick={() => setPage(1)}>« 首页</button>
                  <button className="btn sm" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>‹ 上一页</button>
                  <button className="btn sm" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>下一页 ›</button>
                  <button className="btn sm" disabled={curPage >= totalPages} onClick={() => setPage(totalPages)}>末页 »</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {detail && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setDetail(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 820, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{detail.libName} · {detail.file.name}</span>
              {detail.file.truncated && <span className="tag amber">已截断（&gt;256KB 仅预览头部）</span>}
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setDetail(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
              {detail.file.binary ? (
                <div className="loading">二进制文件，无法预览</div>
              ) : (
                <pre className="mono" style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre', overflowX: 'auto' }}>{detail.file.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
      {editor && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => { if (!editorBusy) setEditor(null); }} />
          <div style={{ position: 'relative', zIndex: 1, width: 860, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{editor.mode === 'create' ? '＋ 新建脚本' : `编辑脚本 · ${editor.name}`}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>scripts/{curName}/</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setEditor(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: 1 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>文件名</span>
                <input
                  className="input mono"
                  style={{ width: 280 }}
                  value={editorName}
                  disabled={editor.mode === 'edit'}
                  onChange={(e) => setEditorName(e.target.value)}
                  placeholder="C-AI-001.py（与用例编号一致即可被执行计划直接运行）"
                />
                <span className="muted" style={{ fontSize: 11 }}>命名 = 用例编号时，「绑定脚本」模式自动关联该用例</span>
              </label>
              <textarea
                className="input mono"
                style={{ flex: 1, minHeight: 320, resize: 'vertical', lineHeight: 1.6, fontSize: 12 }}
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                spellCheck={false}
              />
              {error && <div className="error" style={{ marginBottom: 0 }}>⚠️ {error}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn" onClick={() => setEditor(null)}>取消</button>
                <button className="btn primary" disabled={editorBusy || !editorName.trim()} onClick={() => void saveEditor()}>
                  {editorBusy ? '保存中…' : '保存脚本'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {runResult && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setRunResult(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 720, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>▶ 执行结果 · {runResult.name}</span>
              <span className={`tag ${runResult.status === 'passed' ? 'green' : 'red'}`}>{runResult.status === 'passed' ? '✓ 通过' : '✗ 失败'}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{(runResult.durationMs / 1000).toFixed(1)}s</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setRunResult(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
              <pre className="mono" style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: runResult.status === 'passed' ? 'var(--text2)' : 'var(--red)' }}>{runResult.log}</pre>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 18px', borderTop: '1px solid var(--border)' }}>
              <button className="btn primary" onClick={() => setRunResult(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
