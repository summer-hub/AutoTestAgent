import { useCallback, useEffect, useState } from 'react';
import type { Execution } from 'shared';
import { api } from '../api';

type ExecRow = Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null };

export default function DebugPage() {
  const [execs, setExecs] = useState<ExecRow[]>([]);
  const [selected, setSelected] = useState<ExecRow | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [ask, setAsk] = useState('');
  const [answers, setAnswers] = useState<Array<{ q: string; a: string }>>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.executions({ limit: 30 })
      .then((list) => {
        setExecs(list);
        const failed = list.find((e) => e.status === 'failed');
        if (!selected) setSelected(failed ?? list[0] ?? null);
      })
      .catch((e) => setError(String((e as Error).message)));
  }, [selected]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const select = (e: ExecRow) => {
    setSelected(e);
    setActiveStep(Math.max(0, e.steps.findIndex((s) => s.status === 'failed')));
    setAnswers([]);
  };

  const askAi = () => {
    const q = ask.trim();
    if (!q || !selected || asking) return;
    setAsking(true);
    api.askExecution(selected.id, q)
      .then((r) => setAnswers((prev) => [...prev, { q, a: r.answer }]))
      .catch((e) => setAnswers((prev) => [...prev, { q, a: `追问失败：${(e as Error).message}` }]))
      .finally(() => { setAsking(false); setAsk(''); });
  };

  return (
    <>
      <div className="page-title">调试会话</div>
      <div className="page-desc">执行轨迹可视化 · 左侧执行步骤 · 右侧 AI 思考过程 · 下方可追问判定依据</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14, marginBottom: 14 }}>
        {/* 执行记录列表 */}
        <div className="card" style={{ padding: 12 }}>
          <div className="card-h" style={{ marginBottom: 8 }}><span className="t">执行记录</span><span className="sub">4s 刷新</span></div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {execs.map((e) => (
              <div
                key={e.id}
                className={`nav-item ${selected?.id === e.id ? 'active' : ''}`}
                style={{ margin: 0, borderRadius: 7, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
                onClick={() => select(e)}
              >
                <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8 }}>
                  <span className={`tag ${e.status === 'passed' ? 'green' : e.status === 'failed' ? 'red' : 'gray'}`}>
                    {e.status === 'passed' ? '✓ 通过' : e.status === 'failed' ? '✗ 失败' : e.status}
                  </span>
                  <span className="mono" style={{ fontSize: 11.5 }}>{e.caseNo}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.caseName} · {e.libraryName} · {e.deviceSerial ?? '—'}
                </div>
              </div>
            ))}
            {execs.length === 0 && <div className="loading">暂无执行记录（先在「执行计划」发起执行）</div>}
          </div>
        </div>

        {/* 轨迹 + 思考 */}
        {selected && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="card-h" style={{ padding: '10px 14px', marginBottom: 0, borderBottom: '1px solid var(--border)' }}>
                <span className="t">🎬 执行轨迹 · {selected.caseNo}</span>
                <span className="sub">{selected.libraryName} · 设备 {selected.deviceSerial ?? '—'}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px', maxHeight: 380 }}>
                {selected.steps.map((s, i) => (
                  <div
                    key={s.seq}
                    className={`step ${i === activeStep ? 'active' : ''}`}
                    style={{ display: 'flex', gap: 10, padding: '7px 9px', borderRadius: 8, cursor: 'pointer', alignItems: 'baseline', background: i === activeStep ? 'var(--accent-dim)' : 'transparent' }}
                    onClick={() => setActiveStep(i)}
                  >
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text3)', width: 26, flexShrink: 0, textAlign: 'right' }}>{String(s.seq).padStart(2, '0')}</span>
                    <span className="mono" style={{ fontSize: 12.4, color: i === activeStep ? 'var(--accent2)' : 'var(--text2)' }}>{s.desc}</span>
                    <span style={{ marginLeft: 'auto' }}>
                      <span className={`tag ${s.status === 'passed' ? 'green' : s.status === 'failed' ? 'red' : 'gray'}`}>
                        {s.status === 'passed' ? '通过' : s.status === 'failed' ? '失败' : '跳过'}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="card-h" style={{ padding: '10px 14px', marginBottom: 0, borderBottom: '1px solid var(--border)' }}>
                <span className="t">🧠 AI 思考过程</span>
                <span className="sub">逐步推理 · 可追问</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', fontSize: 12.6, lineHeight: 1.8, color: 'var(--text2)', whiteSpace: 'pre-wrap', maxHeight: 300 }}>
                {selected.thinking ?? '（无思考记录）'}
              </div>
              <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
                <input
                  className="input" style={{ flex: 1 }} placeholder="询问 AI：为什么这样做？判定的依据是什么？…"
                  value={ask} onChange={(e) => setAsk(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void askAi(); }}
                />
                <button className="btn primary" disabled={asking} onClick={() => void askAi()}>{asking ? '思考中…' : '发送'}</button>
              </div>
              {answers.map((a, i) => (
                <div key={i} style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ color: 'var(--text2)', fontSize: 12.6 }}>💬 {a.q}</div>
                  <div style={{ color: 'var(--text3)', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>AI：{a.a}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
