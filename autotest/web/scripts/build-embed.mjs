// 构建嵌入 DSH GUI 的静态包：
//  - VITE_EMBED=1      → 应用使用紧凑嵌入布局（无独立侧边栏/设置弹窗）
//  - VITE_API_BASE=/api/autotest → 同源直连 dsh-autotest 插件路由（无需代理）
//  - base=/autotest-web/ → 静态资源挂在插件 webServer 的前缀下
// 产物输出到 autotest/dsh-autotest/lib/web，随插件一起被 GUI 服务。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'vite';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.VITE_EMBED = '1';
process.env.VITE_API_BASE = '/api/autotest';

await build({
  configFile: join(webRoot, 'vite.config.ts'),
  base: '/autotest-web/',
  build: {
    outDir: join(webRoot, '..', 'dsh-autotest', 'lib', 'web'),
    emptyOutDir: true,
  },
});

console.log('[web:embed] built -> autotest/dsh-autotest/lib/web');
