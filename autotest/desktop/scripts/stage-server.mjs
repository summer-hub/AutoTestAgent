// 把独立服务器打包成桌面端资源（src-tauri/resources/server/）：
//  - lib/ + dist/（standalone.js 与独立版前端）
//  - package.json（保留 "type": "module"，否则 lib/*.js 会被 node 当 CJS 解析直接崩）
//  - node_modules：**只用随包的 node**（.tmp/node）执行 npm install，
//    因为 better-sqlite3 是原生模块，其预编译产物与 node ABI 绑定；
//    用系统 node 安装会在别的 node 版本上加载失败。
//  - 剔除 @types/*、tsx、typescript（纯开发期依赖，运行时不需要）
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverSrc = join(root, '..', 'dsh-autotest');
const outDir = join(root, 'src-tauri', 'resources', 'server');
const bundledNodeDir = join(root, '.tmp', 'node');

// 运行时真正需要的依赖（dsh-autotest 的 dependencies 里混有 @types/* / tsx / typescript）
const RUNTIME_DEPS = ['better-sqlite3', 'ioredis', 'mysql2', 'node-cron', 'xlsx'];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 1. 代码与前端产物
await cp(join(serverSrc, 'lib'), join(outDir, 'lib'), { recursive: true });
await cp(join(serverSrc, 'dist'), join(outDir, 'dist'), { recursive: true });
const pkg = JSON.parse(await readFile(join(serverSrc, 'package.json'), 'utf8'));
pkg.name = 'autotest-server-bundled';
pkg.private = true;
delete pkg.devDependencies;
delete pkg.peerDependencies;
delete pkg.scripts;
delete pkg.dsh;
await writeFile(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));

// 2. 生产依赖（用随包 node 安装，锁定 ABI）
const nodeExe = join(bundledNodeDir, 'node.exe');
const npmCli = join(bundledNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const staging = await mkdtemp(join(tmpdir(), 'autotest-stage-'));
const versions = {};
for (const name of RUNTIME_DEPS) {
  versions[name] = pkg.dependencies?.[name] ?? 'latest';
}
await writeFile(join(staging, 'package.json'), JSON.stringify({
  name: 'autotest-server-staging',
  private: true,
  dependencies: versions,
}, null, 2));
console.log('[stage] installing runtime deps with bundled node:', RUNTIME_DEPS.join(', '));
await run(nodeExe, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: staging,
  maxBuffer: 64 * 1024 * 1024,
});
await cp(join(staging, 'node_modules'), join(outDir, 'node_modules'), { recursive: true });
await rm(staging, { recursive: true, force: true });

// 3. 自检：入口存在 + better-sqlite3 能被随包 node 真正加载
//    （better-sqlite3 v13 用 N-API 预编译 prebuilds/win32-x64.node；直接 require 一次，
//     比查文件路径更硬——加载失败（ABI/文件缺失）在这里就会暴露，而不是等用户打开应用）
const entry = join(outDir, 'lib', 'standalone.js');
const { stat } = await import('node:fs/promises');
try { await stat(entry); } catch { throw new Error(`staged 资源缺失：${entry}`); }
await run(nodeExe, ['-e', "require('better-sqlite3'); console.log('better-sqlite3 load ok')"], {
  cwd: outDir,
  maxBuffer: 16 * 1024 * 1024,
});
console.log(`[stage] server -> ${outDir}（含 lib/ dist/ node_modules[${RUNTIME_DEPS.join(' ')}]）`);
