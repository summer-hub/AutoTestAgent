// CLI：npm run db:init / db:seed（独立初始化用；插件激活时也会自动 ensureSchemaAndSeed）
import { getDb } from './connection.js';
import { seed } from './seed.js';
import { mysqlPool } from './connection.js';

async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'init';
  const db = getDb();
  if (arg === 'seed') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM libraries').get<{ n: number }>();
    if (n && n.n > 0) { console.log('⏭️  已有数据，跳过种子'); return; }
    await seed();
  } else {
    const [rows] = await mysqlPool().query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`,
    ) as [Array<{ name: string }>, unknown];
    console.log('✅ 表：' + rows.map((t) => t.name).join(', '));
  }
}

void main().catch((e) => { console.error(e); process.exit(1); });
