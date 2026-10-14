// 构建步骤：把 assets/ 下的**运行时资产**复制进 lib/assets/。
//
// 为什么需要这一步：tsc 只编译 src/**/*.ts（rootDir=src），产物里天然没有非 TS 文件；
// 而插件分发有三条路，全靠 lib/ 这一个目录被带上：
//   1. pnpm tarball（package.json 的 files: ["lib"]）
//   2. 桌面端打包（desktop/scripts/stage-server.mjs 的 cp(lib)）
//   3. 独立版 / DSH 插件（直接跑 lib/standalone.js 或 lib/index.js）
// 所以只要复制进 lib/assets/，三个入口零额外改动就都能拿到。
//
// 当前资产：
//   三方库测试表.xlsx —— 目录引导的"随包初始种子"（R0，见 docs/重构方案-环境与资源纵轴.md）。
//   SQLite 仍是唯一事实源；这份表只用于首次导入与人工导出增量，绝不回写。
//
// 幂等：每次构建整体覆盖复制（资产是只读的，不存在"半新半旧"问题）。
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'assets');
const out = join(root, 'lib', 'assets');

await mkdir(out, { recursive: true });
// 先清后拷：避免资产被删除后旧文件残留在 lib/assets 里（比如表被换名/下线）。
await rm(out, { recursive: true, force: true });
await cp(src, out, { recursive: true });
console.log(`[assets] ${src} -> ${out}`);
