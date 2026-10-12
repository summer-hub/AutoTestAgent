// 构建独立版（纯 Web）前端：
//  - base='/'                独立服务器站点根（非 DSH iframe 的 /autotest-web/ 前缀）
//  - VITE_API_BASE=/api/autotest  同源直连独立服务器 API 前缀（同源闸门天然通过）
//  - 产物输出到 dsh-autotest/dist/web，随独立服务器一起被服务
//  - 构建后对文本资产生成 .gz 伴生文件：独立服务器运行期按 Accept-Encoding 直接零拷贝发出，
//    不为每个请求付出压缩 CPU（高并发下省的是真金白银）
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(webRoot, '..', 'dsh-autotest', 'dist', 'web');
// 与 static.ts 的 TEXT_MIME 保持一致（只压缩文本类）
const GZIP_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map']);

process.env.VITE_API_BASE = '/api/autotest';
delete process.env.VITE_EMBED; // 独立版不是嵌入布局（侧边栏 + 顶栏 + 设置弹窗）

await build({
  configFile: join(webRoot, 'vite.config.ts'),
  base: '/',
  build: {
    outDir,
    emptyOutDir: true,
  },
});

// ---- .gz 预压缩 ----
let count = 0;
let saved = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) { walk(file); continue; }
    if (file.endsWith('.gz')) continue;
    if (!GZIP_EXT.has(extname(file).toLowerCase())) continue;
    const raw = readFileSync(file);
    const gz = gzipSync(raw, { level: 9 });
    if (gz.length < raw.length) {
      writeFileSync(`${file}.gz`, gz);
      count += 1;
      saved += raw.length - gz.length;
    }
  }
};
walk(outDir);
console.log(`[web:standalone] built -> ${outDir}（预压缩 ${count} 个文本文件，传输量省 ${(saved / 1024).toFixed(0)} KB）`);
