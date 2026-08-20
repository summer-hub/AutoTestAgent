// 清理遗留 running 任务（进程重启残留）
import Database from 'better-sqlite3';
const db = new Database('D:/code/HarmonyProject/20260604/AutoTestAgent/autotest/dsh-autotest/data/autotest.db');
const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
const r = db.prepare(`UPDATE tasks SET status='failed', error='进程重启中断（旧执行残留）', updated_at=? WHERE status='running'`).run(t);
console.log('cleaned tasks:', r.changes);
