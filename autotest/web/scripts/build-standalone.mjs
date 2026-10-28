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

// ---- A3（设计 §13.2）：runtime config.js ----
// 产出 dist/web/config.js 并在 index.html 前置引用（必须在 vite bundle 之前执行）。
// 部署期可直接编辑 config.js 改 apiBase/wsBase（分离拓扑 B/C），无需重新构建前端；
// static.ts 对非 assets/ 文件一律 no-cache，改动即时生效。
const configJs = `// AutoTest 独立版 runtime config（A3 · 设计 §13.2）。在所有 JS bundle 之前加载。
// 部署期可直接编辑本文件：
//   - 同源部署（拓扑 A）：保持默认即可；
//   - 跨域分离（拓扑 C）：apiBase 改为 API 绝对地址，如 'https://api.autotest.example.com/api/autotest'，
//     并在服务端配置 AUTOTEST_CORS_ORIGINS 白名单加入本站点 origin；
//   - wsBase 留空时由 apiBase 推导（https→wss / http→ws，路径固定 /api/autotest/ws）。
window.__AUTOTEST_CONFIG__ = {
  edition: 'standalone',
  apiBase: '/api/autotest',
  wsBase: '',
  features: { baseline: true, scenarioAssets: true, mdReport: true },
};
`;
writeFileSync(join(outDir, 'config.js'), configJs);
const indexPath = join(outDir, 'index.html');
let html = readFileSync(indexPath, 'utf8');
if (!html.includes('config.js')) {
  html = html.replace('<head>', '<head>\n  <script src="/config.js"></script>');
  writeFileSync(indexPath, html);
}

// ---- .gz 预压缩 ----
let count = 0;
let saved = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) { walk(file); continue; }
    if (file.endsWith('.gz')) continue;
    // config.js 是部署期可编辑文件：不预压缩（否则 static.ts 优先发 .gz，部署期改动永远不生效）
    if (file === join(outDir, 'config.js')) continue;
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
