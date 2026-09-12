// 手工清理遗留 running 任务/计划（离线排查用）。
//
// 常驻清理已由 services/reaper.ts 承担（启动清理 + 每 5 分钟按空闲阈值清理），本脚本只是需要
// 立刻手动收拾时的手动入口。
//
// ⚠️ 旧实现的问题（已修）：它把库文件硬编码成作者的绝对路径，且文件名写成 `data/autotest.db`，
// 而实际库名是 `autotest.sqlite3`。better-sqlite3 会"热心地"新建一个空库，于是脚本每次输出
// "cleaned tasks: 0" —— 看起来跑通了，实际什么都没清。现在走真实连接层，路径由
// AUTOTEST_DATA_DIR / 插件根 data 决定，不再硬编码。
//
// ⚠️ 本脚本会写**真实业务库**（并把 running 状态判为中断）。默认需要显式确认：
//     node scripts/clean-stale-tasks.mjs --yes
// 更稳的做法是停掉 DSH 宿主再执行，或干脆依赖内置 reaper。
import process from 'node:process';

if (!process.argv.includes('--yes')) {
  console.error('拒绝执行：本脚本会写真实业务库并把 running 的任务/计划标记为失败。');
  console.error('确认无任务正在执行后，用 --yes 重跑：node scripts/clean-stale-tasks.mjs --yes');
  process.exit(2);
}

process.env.AUTOTEST_DB_MODE ??= 'sqlite';

const { ensureReady } = await import('../lib/db/connection.js');
const { reapStaleRuns } = await import('../lib/services/reaper.js');

await ensureReady();
const r = await reapStaleRuns({ reason: '手工清理' });
console.log(`已清理遗留运行态：任务 ${r.tasks} 个 / 计划 ${r.plans} 个`);

const { sqlite } = await import('../lib/db/sqlite.js');
sqlite().close();
