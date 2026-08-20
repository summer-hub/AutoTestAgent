// CLI：npm run db:init / db:seed（独立初始化用；插件激活时也会自动 ensureSchemaAndSeed）
import { getDb } from './connection.js';
import { SCHEMA } from './schema.js';
import { seed } from './seed.js';
const arg = process.argv[2] ?? 'init';
const db = getDb();
if (arg === 'seed') {
    db.exec(SCHEMA);
    const n = db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n;
    if (n > 0) {
        console.log('⏭️  已有数据，跳过种子');
        process.exit(0);
    }
    seed(db);
}
else {
    db.exec(SCHEMA);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
    console.log('✅ 表：' + tables.map((t) => t.name).join(', '));
}
