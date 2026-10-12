// 危险操作审批队列（P0-4）：挂载于人工接管队列页顶部。
// exec.autoApprove=false 时，危险操作（删库/删用例/删任务/删脚本/拉仓库/生成脚本）在此排队；
// 批准 = 签发一次性放行令牌，发起方重试同一操作即放行；拒绝 = 继续拦截。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

type ApprovalStatus = 'pending' | 'approved' | 'rejected';

interface ApprovalItem {
  id: number;
  kind: string;
  kindLabel: string;
  target: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string;
  reason: string;
  consumed: boolean;
  createdAt: string;
  decidedAt: string;
}

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
};

export default function ApprovalQueue() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [pending, setPending] = useState(0);
  const [onlyPending, setOnlyPending] = useState(true);
  const [busyId, setBusyId] = useState(0);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [reasons, setReasons] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    api.approvals(onlyPending ? 'pending' : undefined)
      .then((r) => { setItems(r.items); setPending(r.pending); })
      .catch((e) => setError(String((e as Error).message)));
  }, [onlyPending]);

  useEffect(() => { load(); }, [load]);

  const decide = async (id: number, decision: 'approve' | 'reject') => {
    setBusyId(id); setError(''); setMsg('');
    try {
      const r = await api.decideApproval(id, decision, reasons[id] ?? '');
      setMsg(`#${id} 已${r.status === 'approved' ? '批准（发起方重试同一操作即放行）' : '拒绝'}`);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusyId(0);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <span className="t">
          危险操作审批
          {pending > 0 && (
            <span className="badge" style={{ marginLeft: 8, background: 'var(--warn, #f59e0b)', color: '#1e293b' }}>{pending} 待批</span>
          )}
        </span>
        <span className="sub">
          系统配置关闭 exec.autoApprove 后生效 · 批准即放行发起方对同一操作的重试 · 仅 operator+ 可决策
        </span>
      </div>

      {error && <div className="error" style={{ marginBottom: 8 }}>⚠️ {error}</div>}
      {msg && <div className="ok" style={{ marginBottom: 8 }}>✓ {msg}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label className="muted" style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
          只看待审批
        </label>
        <div style={{ flex: 1 }} />
        <button className="btn" style={{ fontSize: 12 }} onClick={load}>刷新</button>
      </div>

      <table className="table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>#</th>
            <th style={{ textAlign: 'left' }}>操作</th>
            <th style={{ textAlign: 'left' }}>对象</th>
            <th style={{ textAlign: 'left' }}>状态</th>
            <th style={{ textAlign: 'left' }}>发起</th>
            <th style={{ textAlign: 'left' }}>时间</th>
            <th style={{ textAlign: 'left' }}>决策</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={7} className="muted" style={{ padding: 14 }}>
              {onlyPending ? '没有待审批的危险操作' : '暂无审批记录'}
            </td></tr>
          )}
          {items.map((a) => (
            <tr key={a.id}>
              <td className="mono">#{a.id}</td>
              <td>{a.kindLabel}</td>
              <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{a.target}</td>
              <td>
                <span className="tag">{STATUS_LABEL[a.status] ?? a.status}</span>
                {a.status === 'approved' && a.consumed && <span className="muted" style={{ fontSize: 11 }}> · 已放行</span>}
              </td>
              <td className="muted">{a.requestedBy || '—'}</td>
              <td className="muted">{a.decidedAt || a.createdAt}</td>
              <td>
                {a.status === 'pending' ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="input"
                      style={{ width: 110, fontSize: 12 }}
                      placeholder="理由（可选）"
                      value={reasons[a.id] ?? ''}
                      onChange={(e) => setReasons((r) => ({ ...r, [a.id]: e.target.value }))}
                    />
                    <button className="btn primary" style={{ fontSize: 12 }} disabled={busyId === a.id} onClick={() => void decide(a.id, 'approve')}>
                      {busyId === a.id ? '…' : '批准'}
                    </button>
                    <button className="btn" style={{ fontSize: 12 }} disabled={busyId === a.id} onClick={() => void decide(a.id, 'reject')}>
                      拒绝
                    </button>
                  </div>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {a.decidedBy || '—'}{a.reason ? ` · ${a.reason}` : ''}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
