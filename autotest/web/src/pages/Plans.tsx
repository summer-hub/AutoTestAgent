import { useCallback, useEffect, useState } from 'react';
import type { Library, Plan, TestCase } from 'shared';
import { api } from '../api';

const TYPE_OPTIONS: Array<{ v: string; icon: string; label: string; desc: string }> = [
  { v: 'immediate', icon: '⚡', label: '立即执行', desc: '创建后马上执行' },
  { v: 'scheduled', icon: '🕐', label: '定时执行', desc: 'Cron 表达式周期执行' },
  { v: 'single', icon: '🎯', label: '单独执行', desc: '单个用例 / 单个库' },
  { v: 'batch', icon: '📦', label: '批量执行', desc: '多个用例 / 多个库' },
  { v: 'full', icon: '🌐', label: '全量执行', desc: '全部 400 库用例（抽样演示）' },
];

const TYPE_TAG: Record<string, string> = { immediate: 'amber', scheduled: 'blue', single: 'green', batch: 'cyan', full: 'purple' };
const STATUS_TAG: Record<string, string> = { draft: 'gray', running: 'blue', done: 'green', failed: 'red', stopped: 'gray' };

export default function PlansPage() {
  const [plans, setPlans] = useState<Array<Plan & { typeLabel?: string; execStats?: { passed: number; failed: number; total: number } | null }>>([]);
  const [libs, setLibs] = useState<Library[]>([]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'immediate', cron: '0 2 * * *', libraryId: 0, deviceIds: [1] as number[], failPolicy: 'continue' });
  // 跨库用例多选
  const [selCases, setSelCases] = useState<Map<number, { caseNo: string; name: string; libraryName: string }>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLib, setPickerLib] = useState(0);
  const [pickerCases, setPickerCases] = useState<TestCase[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const load = useCallback(() => {
    api.plans().then(setPlans).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => {
    load();
    api.libraries({ pageSize: 100 }).then((r) => setLibs(r.items)).catch(() => {});
  }, [load]);

  const create = async () => {
    setError('');
    try {
      const scope = form.type === 'full'
        ? { libraryIds: [], caseIds: [] }
        : selCases.size > 0
          ? { libraryIds: [], caseIds: [...selCases.keys()] }
          : { libraryIds: form.libraryId ? [form.libraryId] : [], caseIds: [] };
      await api.createPlan({
        name: form.name || '未命名计划',
        type: form.type as 'immediate' | 'scheduled' | 'single' | 'batch' | 'full',
        cron: form.type === 'scheduled' ? form.cron : undefined,
        scope,
        deviceIds: form.deviceIds,
        failPolicy: form.failPolicy as Plan['failPolicy'],
      });
      setModal(false);
      setSelCases(new Map());
      load();
    } catch (e) { setError((e as Error).message); }
  };

  const openPicker = () => {
    setPickerOpen(true);
    const first = libs[0]?.id ?? 0;
    setPickerLib(first);
    if (first) loadPickerCases(first);
  };

  const loadPickerCases = (libraryId: number) => {
    setPickerLoading(true);
    api.cases(libraryId, { page: 1, pageSize: 200 })
      .then((r) => { setPickerCases(r.items); })
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setPickerLoading(false));
  };

  const toggleCase = (c: TestCase, libName: string) => {
    setSelCases((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, { caseNo: c.caseNo, name: c.name, libraryName: libName });
      return next;
    });
  };

  const runNow = async (id: number) => {
    try { await api.runPlan(id); load(); setTimeout(load, 3000); } catch (e) { setError((e as Error).message); }
  };

  const remove = async (id: number) => {
    try { await api.deletePlan(id); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <div className="page-title">执行计划</div>
      <div className="page-desc">用例库绑定自动化脚本后执行测试 · 立即 / 定时 / 单独 / 批量 / 全量（默认 hdc 真机执行，无设备自动回退模拟）</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setModal(true)}>＋ 新建执行计划</button>
      </div>

      {plans.length === 0 ? (
        <div className="card"><div className="loading">暂无执行计划</div></div>
      ) : (
        plans.map((p) => (
          <div key={p.id} className="card" style={{ marginBottom: 10, padding: '13px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className={`tag ${TYPE_TAG[p.type] ?? 'gray'}`}>{p.typeLabel ?? p.type}</span>
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 13.5 }}>{p.name}</b>
                <div className="muted" style={{ fontSize: 11.8, marginTop: 3 }}>
                  {p.planNo} · {p.type === 'full' ? '全量' : p.type === 'scheduled' ? `cron ${p.cron}` : p.type} · 创建于 {p.createdAt}
                </div>
              </div>
              {p.execStats && (
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: 'var(--green)' }}>✓ {p.execStats.passed}</span>
                  {' / '}
                  <span style={{ color: 'var(--red)' }}>✗ {p.execStats.failed}</span>
                  <span className="muted"> / {p.execStats.total}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn sm" onClick={() => runNow(p.id)}>▶ 立即执行</button>
                <button className="btn sm ghost" onClick={() => remove(p.id)}>删除</button>
              </div>
            </div>
          </div>
        ))
      )}

      {modal && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className="drawer" style={{ width: 600 }}>
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>新建执行计划</span>
              <span className="x" onClick={() => setModal(false)}>✕</span>
            </div>
            <div className="drawer-b">
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">计划名称</div></div>
                <input className="input" style={{ flex: 1 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 clock-ohos 回归执行" />
              </div>
              <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <div className="fl"><div className="ft">执行类型</div></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, flex: 1 }}>
                  {TYPE_OPTIONS.map((t) => (
                    <div
                      key={t.v}
                      style={{ border: `1px solid ${form.type === t.v ? 'var(--accent)' : 'var(--border2)'}`, background: form.type === t.v ? 'var(--accent-dim)' : 'transparent', borderRadius: 9, padding: '10px 12px', cursor: 'pointer' }}
                      onClick={() => setForm({ ...form, type: t.v })}
                    >
                      <div style={{ fontWeight: 600, fontSize: 12.3 }}>{t.icon} {t.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{t.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
              {form.type === 'scheduled' && (
                <div className="s-field" style={{ marginBottom: 12 }}>
                  <div className="fl"><div className="ft">Cron 表达式</div></div>
                  <input className="input mono" style={{ flex: 1 }} value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
                </div>
              )}
              {form.type !== 'full' && (
                <div className="s-field" style={{ marginBottom: 12 }}>
                  <div className="fl"><div className="ft">选择范围</div></div>
                  <select className="select" style={{ flex: 1 }} value={form.libraryId} onChange={(e) => setForm({ ...form, libraryId: Number(e.target.value) })}>
                    <option value={0}>全部库</option>
                    {libs.map((l) => <option key={l.id} value={l.id}>{l.name}（{l.caseCount} 用例）</option>)}
                  </select>
                </div>
              )}
              {form.type !== 'full' && (
                <div className="s-field" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                  <div className="fl"><div className="ft">指定用例（可跨库多选）</div></div>
                  <div style={{ flex: 1 }}>
                    <button className="btn sm" onClick={openPicker}>☑ 选择用例{selCases.size > 0 ? `（已选 ${selCases.size} 条）` : ''}</button>
                    {selCases.size > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
                        {[...selCases.entries()].map(([id, c]) => (
                          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, border: '1px solid var(--border)', borderRadius: 7, padding: '4px 8px' }}>
                            <span className="muted" style={{ flexShrink: 0 }}>{c.libraryName}</span>
                            <span className="mono" style={{ color: 'var(--accent2)', flexShrink: 0 }}>{c.caseNo}</span>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                            <span className="link" style={{ color: 'var(--red)' }} onClick={() => setSelCases((prev) => { const n = new Map(prev); n.delete(id); return n; })}>移除</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="s-field" style={{ marginBottom: 12 }}>
                <div className="fl"><div className="ft">失败处理</div></div>
                <select className="select" style={{ flex: 1 }} value={form.failPolicy} onChange={(e) => setForm({ ...form, failPolicy: e.target.value })}>
                  <option value="continue">停止当前用例，继续后续</option>
                  <option value="abort_library">整库失败即中止</option>
                  <option value="retry_twice">失败自动重试 2 次</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn" onClick={() => setModal(false)}>取消</button>
                <button className="btn primary" onClick={create}>创建计划</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <div className="drawer-mask show" onClick={(e) => { if (e.target === e.currentTarget) setPickerOpen(false); }}>
          <div className="drawer" style={{ width: 680 }}>
            <div className="drawer-h">
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>选择用例（可跨库多选，勾选后加入执行范围）</span>
              <span className="x" onClick={() => setPickerOpen(false)}>✕</span>
            </div>
            <div className="drawer-b">
              <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center' }}>
                <select
                  className="select"
                  style={{ width: 260 }}
                  value={pickerLib}
                  onChange={(e) => { const id = Number(e.target.value); setPickerLib(id); loadPickerCases(id); }}
                >
                  {libs.map((l) => <option key={l.id} value={l.id}>{l.name}（{l.caseCount} 用例）</option>)}
                </select>
                <span className="muted" style={{ fontSize: 12 }}>已选 {selCases.size} 条</span>
                <div style={{ flex: 1 }} />
                <button className="btn primary sm" onClick={() => setPickerOpen(false)}>完成</button>
              </div>
              {pickerLoading ? (
                <div className="loading">加载用例…</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 380, overflowY: 'auto' }}>
                  {pickerCases.map((c) => {
                    const libName = libs.find((l) => l.id === c.libraryId)?.name ?? '';
                    const checked = selCases.has(c.id);
                    return (
                      <div
                        key={c.id}
                        onClick={() => toggleCase(c, libName)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`, background: checked ? 'var(--accent-dim)' : 'transparent', cursor: 'pointer', fontSize: 12.5 }}
                      >
                        <span style={{ width: 18, textAlign: 'center', color: checked ? 'var(--accent2)' : 'var(--text3)' }}>{checked ? '✓' : ''}</span>
                        <span className="mono" style={{ color: 'var(--accent2)', width: 90, flexShrink: 0 }}>{c.caseNo}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        <span className={`tag ${c.source === '真机遍历' ? 'green' : 'plain'}`}>{c.source}</span>
                      </div>
                    );
                  })}
                  {pickerCases.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: 12 }}>该库暂无用例</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
