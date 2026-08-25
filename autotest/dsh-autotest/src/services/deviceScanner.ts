// 设备自动检测：周期性 hdc list targets → 自动维护 devices 表在线状态
//  - 插件启动即扫描一次；此后每 5s tick，按配置间隔（device.autoScanInterval 秒，默认 30，0=关闭）触发
//  - 仅维护本地 devices 表（在线/离线、型号/系统版本），不产生模拟设备
import { getDb, dbMode, now } from '../db/connection.js';
import { deviceInfo, hdcAvailable, listTargets } from './hdc.js';
import { getSetting } from './settings.js';
import { cacheDel } from './cache.js';

let scanning = false;
let lastScanAt = 0;

/** 历史版本演示模式写入的假设备型号签名。 */
const SIMULATED_MODELS = ['Mate X5', 'Pura 70', 'nova 13', 'MatePad Pro', 'Pocket 2'];

/** 清理历史模拟设备残留（按型号签名精确匹配，真实设备不受影响）。 */
export async function purgeSimulatedDevices(): Promise<number> {
  try {
    const marks = SIMULATED_MODELS.map(() => '?').join(',');
    const r = await getDb().prepare(`DELETE FROM devices WHERE model IN (${marks})`).run(...SIMULATED_MODELS);
    const n = Number(r.changes) || 0;
    if (n > 0) {
      void cacheDel('devices');
      console.warn(`[autotest] 已清理 ${n} 条历史模拟设备。若反复出现，说明仍有旧版本进程在运行并写入，请重启所有 DSH 宿主进程`);
    }
    return n;
  } catch { return 0; }
}

/** 双方言设备 upsert（MySQL ON DUPLICATE KEY / SQLite ON CONFLICT）。 */
async function upsertOnlineDevice(serial: string, model: string, osVersion: string, t: string): Promise<void> {
  const sql = dbMode() === 'sqlite'
    ? `INSERT INTO devices (serial, model, os_version, status, last_seen_at, created_at)
       VALUES (?, ?, ?, 'online', ?, ?)
       ON CONFLICT(serial) DO UPDATE SET model = excluded.model, os_version = excluded.os_version,
         status = 'online', last_seen_at = excluded.last_seen_at`
    : `INSERT INTO devices (serial, model, os_version, status, last_seen_at, created_at)
       VALUES (?, ?, ?, 'online', ?, ?)
       ON DUPLICATE KEY UPDATE model=VALUES(model), os_version=VALUES(os_version), status='online', last_seen_at=VALUES(last_seen_at)`;
  await getDb().prepare(sql).run(serial, model, osVersion, t, t);
}

/**
 * 扫描一次真机并更新数据库状态。
 * 返回 detected = 本次 hdc 发现的设备数（-1 表示已有扫描在进行）。
 */
export async function autoScanDevices(): Promise<{ ok: boolean; detected: number; reason?: string }> {
  if (scanning) return { ok: false, detected: -1, reason: '扫描进行中' };
  scanning = true;
  try {
    const db = getDb();
    const t = now();
    if (!(await hdcAvailable())) return { ok: false, detected: 0, reason: 'hdc 不可用' };
    const targets = await listTargets();
    if (targets.length === 0) {
      await db.prepare(`UPDATE devices SET status = 'offline' WHERE status = 'online'`).run();
      lastScanAt = Date.now();
      void cacheDel('devices');
      return { ok: true, detected: 0 };
    }
    for (const serial of targets) {
      const info = await deviceInfo(serial);
      await upsertOnlineDevice(serial, info.model, info.osVersion, t);
    }
    const marks = targets.map(() => '?').join(',');
    await db.prepare(`UPDATE devices SET status = 'offline' WHERE status = 'online' AND serial NOT IN (${marks})`).run(...targets);
    lastScanAt = Date.now();
    void cacheDel('devices');
    return { ok: true, detected: targets.length };
  } catch (e) {
    console.warn('[autotest] 设备自动检测失败：', (e as Error).message);
    return { ok: false, detected: 0, reason: (e as Error).message };
  } finally {
    await purgeSimulatedDevices();
    scanning = false;
  }
}

/** 启动入口：立即扫一次（含假设备清理）+ 周期 tick。 */
export function startDeviceAutoScan(): void {
  void purgeSimulatedDevices();
  void autoScanDevices().then((r) => {
    if (r.ok && r.detected > 0) console.log(`[autotest] 设备自动检测：发现 ${r.detected} 台在线设备`);
  });
  setInterval(() => {
    const intervalSec = Math.max(0, Number(getSetting('device.autoScanInterval', 30)) || 0);
    if (intervalSec <= 0) return; // 0 = 关闭自动检测
    if (Date.now() - lastScanAt < intervalSec * 1000) return;
    autoScanDevices().catch(() => {});
  }, 5000);
}
