import { useCallback, useEffect, useState } from 'react';
import type { Library } from 'shared';
import { api } from '../api';

/**
 * 人工接管队列（P7）：自动化跑不了的用例落到这里，每条必须包含四段 ——
 * 「原因 / 需要你做什么 / 上下文证据 / 回填结论」。
 *
 * 为什么必须有"需要你做什么"：阻塞原因只是把问题描述了一遍，人看完仍然不知道该动手做什么，
 * 队列就变成了垃圾场。所以每条都由规则生成一句可执行的动作（去批准补丁 / 补一条可校验断言 /
 * 连一台设备…），并且回填后会自动重跑分流 —— 结论要么解除阻塞，要么仍然是阻塞并重新入队。
 */
type BlockerStage = 'demo_patch' | 'oracle_missing' | 'external_dep' | 'animation' | 'video' | 'flaky' | 'device_blocked' | 'long_running' | 'untestable';

interface QueueItem {
  id: number; caseId: number | null; caseNo: string; caseName: string;
  stage: BlockerStage; reason: string; question: string;
  payload: {
    caseNo?: string; caseName?: string; testability?: string; estimatedSeconds?: number;
    oracleCount?: number; steps?: string[];
    patchDraft?: null | { class: string; target: string; reason: string; edits: Array<{ file: string; line: number; before: string; after: string; note: string }> } | null;
  };
  status: string; resolution: string; resolvedBy: string; resolvedAt: string | null; createdAt: string;
}

const STAGE_LABEL: Record<BlockerStage, string> = {
  demo_patch: '补丁待批准',
  oracle_missing: '缺可校验断言',
  external_dep: '外部依赖',
  animation: '动画需人工判定',
  video: '音视频需人工判定',
  flaky: '结果不稳定',
  device_blocked: '无可用设备',
  long_running: '预计超时',
  untestable: '判定为无法测',
};

const STAGE_COLOR: Record<BlockerStage, string> = {
  demo_patch: 'blue', oracle_missing: 'red', external_dep: 'amber', animation: 'purple',
  video: 'purple', flaky: 'amber', device_blocked: 'gray', long_running: 'gray', untestable: 'red',
};

export default function HumanQueuePage() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [libId, setLibId] = useState(0);
  const [data, setData] = useState<{ total: number; open: number; byStage: Record<string, number>; items: QueueItem[] } | null>(null);  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fill, setFill] = useState<Record<number, string>>({});

  useEffect(() => {
    api.libraries({ pageSize: 300 }).then((r) => {
      setLibs(r.items);
      if (r.items.length > 0) setLibId(r.items[0].id);
    }).catch((e) => setError(String((e as Error).message)));
  }, []);

  const load = useCallback((id: number, open = onlyOpen) => {
    if (!id) return;
    setLoading(true); setError('');
    api.humanQueue(id, open ? 'open' : undefined)
      .then((r) => setData({ ...r, items: r.items.map((i) => ({ ...i, stage: i.stage as BlockerStage })) }))
      .catch((e) => { setError(String((e as Error).message)); setData(null); })
      .finally(() => setLoading(false));
  }, [onlyOpen]);

  useEffect(() => { load(libId, onlyOpen); }, [libId, onlyOpen, load]);

  const triage = async () => {
    if (!libId) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.triage(libId);
      const blockers = Object.entries(r.byBlocker).map(([k, v]) => `${STAGE_LABEL[k as BlockerStage] ?? k} ${v}`).join(' · ');
      setMsg(`分流完成：${r.total} 条用例 → 可自动化 ${r.auto} · 人工 ${r.human}${blockers ? `（${blockers}）` : ''} · 新增队列条目 ${r.queued}`);
      load(libId, onlyOpen);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const resolve = async (item: QueueItem) => {
    const text = (fill[item.id] ?? '').trim();
    if (!text) { setError('请先填写结论（结论会沉淀为知识条目，空结论等于没处理）'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.resolveQueueItem(item.id, text);
      setMsg(`${r.message}${r.requeued ? '（该阻塞仍存在，已重新入队）' : ''}`);
      setFill((f) => ({ ...f, [item.id]: '' }));
      load(libId, onlyOpen);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const items = data?.items ?? [];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="page-title" style={{ marginBottom: 0 }}>人工接管队列</div>
          <div className="page-desc">
            自动跑不了的用例落在这里 · 每条都带「原因 / 需要你做什么 / 证据 / 回填结论」
            {data && <span className="muted"> · 待处理 {data.open} / 共 {data.total}</span>}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ width: 240 }} value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
          {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className={`btn sm ${onlyOpen ? 'primary' : ''}`} onClick={() => setOnlyOpen((v) => !v)}>
          {onlyOpen ? '只看待处理' : '看全部'}
        </button>
        <button className="btn primary" disabled={busy || !libId} onClick={() => void triage()}>
          {busy ? '分流中…' : '重跑分流'}
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {data && Object.keys(data.byStage).length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>阻塞类别分布</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(data.byStage).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <span key={k} className={`tag ${STAGE_COLOR[k as BlockerStage] ?? 'gray'}`}>
                {STAGE_LABEL[k as BlockerStage] ?? k} {v}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        {loading ? (
          <div className="loading">加载中…</div>
        ) : items.length === 0 ? (
          <div className="loading">
            没有待处理项。先点右上角「重跑分流」——它会为每条用例算出「可自动化 / 人工接管」的归属，
            并把阻塞项按类别入队（需要已经跑过可测性判定与接口采集）。
          </div>
        ) : (
          items.map((it) => (
            <div key={it.id} className="card" style={{ marginBottom: 10, borderColor: it.status === 'open' ? 'var(--amber-dim)' : 'var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className={`tag ${STAGE_COLOR[it.stage] ?? 'gray'}`}>{STAGE_LABEL[it.stage] ?? it.stage}</span>
                <span className="mono" style={{ fontSize: 12 }}>{it.caseNo || '（无关联用例）'}</span>
                <span style={{ fontSize: 12.5 }}>{it.caseName}</span>
                {it.status !== 'open' && <span className="tag green">已处理</span>}
                <div style={{ flex: 1 }} />
                <span className="link" onClick={() => setExpanded(expanded === it.id ? null : it.id)}>
                  {expanded === it.id ? '收起证据' : '查看证据'}
                </span>
              </div>

              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                <div><b>原因</b>：{it.reason}</div>
                <div style={{ marginTop: 4, color: 'var(--accent2)' }}><b>需要你做什么</b>：{it.question}</div>
              </div>

              {expanded === it.id && (
                <div style={{ marginTop: 8, background: 'var(--panel3)', borderRadius: 8, padding: 8, fontSize: 11.8, lineHeight: 1.8 }}>
                  <div><b>可测性判定</b>：{it.payload.testability || '未判定'} · <b>预计时长</b>：{it.payload.estimatedSeconds ?? '—'}s · <b>oracle 条数</b>：{it.payload.oracleCount ?? 0}</div>
                  {it.payload.steps && it.payload.steps.length > 0 && (
                    <div><b>步骤</b>：<span className="mono">{it.payload.steps.join(' → ').slice(0, 300)}</span></div>
                  )}
                  {it.payload.patchDraft ? (
                    <div style={{ marginTop: 6 }}>
                      <b>补丁草案</b>（{it.payload.patchDraft.class} 类 · 目标 <span className="mono">{it.payload.patchDraft.target}</span>）
                      <div className="muted">{it.payload.patchDraft.reason}</div>
                      {it.payload.patchDraft.edits.map((e, i) => (
                        <div key={i} style={{ marginTop: 4 }}>
                          <div className="mono">{e.file}:{e.line}</div>
                          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, background: 'var(--red-dim)', padding: 4, borderRadius: 4 }}>- {e.before.slice(0, 300)}</pre>
                          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '2px 0 0', background: 'var(--green-dim)', padding: 4, borderRadius: 4 }}>+ {e.after.slice(0, 300)}</pre>
                        </div>
                      ))}
                      <div className="muted" style={{ marginTop: 4 }}>补丁需到用例页的「补丁」评审视图里批准应用（只在独立副本上生效）。</div>
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 4 }}>没有可自动应用的补丁草案（原因见上）。</div>
                  )}
                </div>
              )}

              {it.status === 'open' ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <textarea
                    className="input"
                    style={{ flex: 1, minHeight: 48, lineHeight: 1.6 }}
                    placeholder={it.stage === 'oracle_missing'
                      ? '填写结论；若要直接写入判据，请把 oracle JSON 一起粘进来，例如：[{"type":"text_value","control":"实际结果：","op":"contains","value":"true"}]'
                      : '填写结论（会作为知识条目的来源，下次同类问题可直接复用）'}
                    value={fill[it.id] ?? ''}
                    onChange={(e) => setFill((f) => ({ ...f, [it.id]: e.target.value }))}
                  />
                  <button className="btn primary" disabled={busy} onClick={() => void resolve(it)}>回填结论</button>
                </div>
              ) : (
                <div className="ok" style={{ marginTop: 8, fontSize: 11.8 }}>
                  ✓ 结论（{it.resolvedBy} · {it.resolvedAt ?? ''}）：{it.resolution}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
