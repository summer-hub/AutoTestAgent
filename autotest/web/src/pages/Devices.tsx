import { useCallback, useEffect, useState } from 'react';
import type { Device } from 'shared';
import { api } from '../api';

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.devices().then(setDevices).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => { load(); }, [load]);

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
      <div className="page-desc">单设备 / 多设备管理 · 设备识别 · 历史设备保存</div>

      {error && <div className="error">⚠️ {error}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <button className="btn primary" onClick={scan} disabled={scanning}>📡 {scanning ? '识别中…' : '识别设备'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{msg || '通过 hdc 扫描局域网 / USB 连接的鸿蒙设备'}</span>
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
              <button className="btn sm">设备详情</button>
              <button className="btn sm ghost" onClick={() => remove(d)}>移除</button>
            </div>
          </div>
        ))}
        {online.length === 0 && <div className="card"><div className="loading">无在线设备，点击「识别设备」扫描</div></div>}
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
    </>
  );
}
