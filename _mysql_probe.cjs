const mysql = require('mysql2/promise');
(async () => {
  for (const uri of ['mysql://root@127.0.0.1:3306', 'mysql://root:root@127.0.0.1:3306', 'mysql://root:123456@127.0.0.1:3306']) {
    try {
      const c = await mysql.createConnection(uri);
      const [r] = await c.query('SELECT VERSION() v, CURRENT_USER() u');
      console.log('OK', uri, JSON.stringify(r[0]));
      await c.query('CREATE DATABASE IF NOT EXISTS autotest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      console.log('db autotest ensured');
      await c.end();
      process.exit(0);
    } catch (e) { console.log('FAIL', uri, e.message.slice(0, 80)); }
  }
  process.exit(1);
})();
