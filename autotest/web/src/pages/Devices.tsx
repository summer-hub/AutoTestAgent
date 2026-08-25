import { useCallback, useEffect, useState } from 'react';
import type { Device } from 'shared';
import { api } from '../api';

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  // 设备详情弹窗
  const [detail, setDetail] = useState<Device | null>(null);
  const [detailExecs, setDetailExecs] = useState<Array<{ id: number; caseNo: string; caseName: string; status: string; startedAt: string | null }>>([]);
  const [rescanning, setRescanning] = useState(false);

  const openDetail = (d: Device): void => {
    setDetail(d);
    setDetailExecs([]);
    api.executions({ limit: 100 })
      .then((items) => setDetailExecs(items.filter((e) => e.deviceSerial === d.serial).slice(0, 8)))
      .catch(() => {});
  };

  const rescan = async (): Promise<void> => {
    if (!detail) return;
    setRescanning(true);
    setError('');
    try {
      await api.scanDevices();
      load();
      const fresh = (await api.devices()).find((x) => x.id === detail.id);
      if (fresh) setDetail(fresh);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRescanning(false);
    }
  };

  const load = useCallback(() => {
    api.devices().then(setDevices).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => { load(); }, [load]);

  // 自动检测：后端周期扫描 hdc，前端每 8 秒刷新列表（无需手动点击）
  useEffect(() => {
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const scan = async () => {
    setScanning(true);
    setMsg('正在扫描局域网 / USB 设备…（hdc list targets）');
    setTimeout(async () => {
      try {
        const r = await api.scanDevices();
        setMsg(r.discovered
          ? `识别完成：${r.device.serial}（${r.device.model}）· ${r.note ?? ''}（共 ${r.total} 台）`
          : (r.note ?? '未发现新设备'));
        load();
      } catch (e) { setError((e as Error).message); }
      setScanning(false);
    }, 1200);
  };

  const connect = async (d: Device) => {
    try { await api.connectDevice(d.id); load(); } catch (e) { setError((e as Error).message); }
  };

  const remove = async (d: Device) => {
    try { await api.deleteDevice(d.id); load(); } catch (e) { setError((e as Error).message); }
  };

  const online = devices.filter((d) => d.status === 'online');
  const history = devices.filter((d) => d.status === 'history');

  return (
    <>
      <div className="page-title">设备管理</div>
      <div className="page-desc">连接真机后自动检测上线（启动即扫 + 周期检测，默认 30s 可配置）· 无需手动点击识别</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <button className="btn primary" onClick={scan} disabled={scanning}>📡 {scanning ? '识别中…' : '立即扫描'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{msg || '自动检测已开启：连接鸿蒙机型设备后数秒内自动上线；也可点击立即扫描'}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        {online.map((d) => (
          <div key={d.id} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--panel3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>📱</div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{d.model || '未知型号'}</div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{d.serial}</div>
              </div>
              <span className="tag green" style={{ marginLeft: 'auto' }}>● 在线</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.9 }}>
              <b style={{ color: 'var(--text)' }}>系统：</b>{d.osVersion || '—'}<br />
              <b style={{ color: 'var(--text)' }}>电量：</b>{d.battery != null ? `${d.battery}%` : '—'} · <b style={{ color: 'var(--text)' }}>内存：</b>{d.memoryUsage != null ? `${d.memoryUsage}%` : '—'}<br />
              <b style={{ color: 'var(--text)' }}>最后在线：</b>{d.lastSeenAt ?? '—'}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button className="btn sm" onClick={() => openDetail(d)}>设备详情</button>
              <button className="btn sm ghost" onClick={() => remove(d)}>移除</button>
            </div>
          </div>
        ))}
        {online.length === 0 && <div className="card"><div className="loading">未检测到在线设备。请通过 USB 连接鸿蒙机型设备（开启 USB 调试），连接后将自动检测上线</div></div>}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <span className="t">🕘 历史设备</span>
          <span className="sub">共 {history.length} 台 · 保留连接信息与执行记录</span>
        </div>
        {history.length === 0 ? (
          <div className="loading">暂无历史设备</div>
        ) : (
          <table>
            <tr><th>设备</th><th>型号</th><th>最后在线</th><th>操作</th></tr>
            {history.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.serial}</td>
                <td>{d.model} · {d.osVersion}</td>
                <td className="muted">{d.lastSeenAt ?? '—'}</td>
                <td className="row-actions">
                  <span className="link" onClick={() => connect(d)}>重新连接</span>
                  <span className="link" style={{ color: 'var(--red)' }} onClick={() => remove(d)}>移除</span>
                </td>
              </tr>
            ))}
          </table>
        )}
      </div>
      {detail && (
        <div className="s-overlay show">
          <div className="s-mask" onClick={() => setDetail(null)} />
          <div style={{ position: 'relative', zIndex: 1, width: 560, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>📱 设备详情 · {detail.model || '未知型号'}</span>
              <span className={`tag ${detail.status === 'online' ? 'green' : 'gray'}`}>{detail.status === 'online' ? '● 在线' : detail.status === 'history' ? '历史' : '离线'}</span>
              <div style={{ flex: 1 }} />
              <button className="s-header x" onClick={() => setDetail(null)} style={{ width: 28, height: 28, borderRadius: 28, border: 'none', background: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '16px 18px', overflowY: 'auto' }}>
              <table>
                <tbody>
                  <tr><td className="muted" style={{ width: 96 }}>序列号</td><td className="mono">{detail.serial}</td></tr>
                  <tr><td className="muted">型号</td><td>{detail.model || '—'}</td></tr>
                  <tr><td className="muted">系统版本</td><td>{detail.osVersion || '—'}</td></tr>
                  <tr><td className="muted">电量 / 内存</td><td>{detail.battery != null ? `${detail.battery}%` : '—'} / {detail.memoryUsage != null ? `${detail.memoryUsage}%` : '—'}</td></tr>
                  <tr><td className="muted">最后在线</td><td>{detail.lastSeenAt ?? '—'}</td></tr>
                  <tr><td className="muted">接入时间</td><td>{detail.createdAt ?? '—'}</td></tr>
                </tbody>
              </table>

              <div className="card-h" style={{ margin: '16px 0 8px' }}>
                <span className="t">该设备最近执行记录</span>
                <span className="sub">最多显示 8 条</span>
              </div>
              {detailExecs.length === 0 ? (
                <div className="muted" style={{ fontSize: 12.3, padding: '4px 2px 8px' }}>
                  暂无执行记录。在「执行计划」页运行计划（真机执行）后，这里会展示该设备的用例执行情况。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {detailExecs.map((e) => (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.3, border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px' }}>
                      <span className={`tag ${e.status === 'passed' ? 'green' : e.status === 'failed' ? 'red' : e.status === 'running' ? 'blue' : 'gray'}`}>
                        {e.status === 'passed' ? '通过' : e.status === 'failed' ? '失败' : e.status === 'running' ? '执行中' : e.status}
                      </span>
                      <span className="mono" style={{ color: 'var(--accent2)', flexShrink: 0 }}>{e.caseNo}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.caseName}</span>
                      <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>{(e.startedAt ?? '').replace('T', ' ').slice(0, 19)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
              <button className="btn" disabled={rescanning} onClick={() => void rescan()} title="hdc list targets 实时识别并刷新在线状态">{rescanning ? '识别中…' : '🔄 重新识别'}</button>
              <button className="btn primary" onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
