// 下载 Node.js LTS（Windows x64）并取出 node.exe 作为 Tauri externalBin sidecar：
//  - 产物：src-tauri/bin/node-x86_64-pc-windows-msvc.exe（tauri 会把它放到 exe 同级目录）
//  - 同时解出 node_modules/npm 到 .tmp/node/，供 stage-server.mjs 用同一运行时安装生产依赖
//    （better-sqlite3 是原生模块，必须与随包的 node ABI 一致，不能用系统 node 安装）
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename, cp, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = join(root, 'src-tauri', 'bin');
const tmpDir = join(root, '.tmp');
const TRIPLE = 'x86_64-pc-windows-msvc';
const MAJOR = 22; // LTS

await mkdir(binDir, { recursive: true });
await mkdir(tmpDir, { recursive: true });

// 1. 选版本：最新的 v22 LTS
const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
const pick = index.find((v) => v.version.startsWith(`v${MAJOR}.`) && v.lts);
if (!pick) throw new Error(`未找到 Node v${MAJOR} LTS 版本`);
console.log(`[fetch-node] ${pick.version} (lts: ${pick.lts})`);

// 2. 下载 zip
const zip = join(tmpDir, `node-${pick.version}-win-x64.zip`);
if (!(await exists(zip))) {
  console.log(`[fetch-node] downloading ${pick.version}-win-x64.zip …`);
  const res = await fetch(`https://nodejs.org/dist/${pick.version}/node-${pick.version}-win-x64.zip`);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import('node:fs/promises');
  await writeFile(zip, buf);
  console.log(`[fetch-node] downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

// 3. 解出 node.exe 与 npm
// 注意：node 官方发行包是 zip（不是 tar，Windows 自带 bsdtar 不直接认 zip），
// 用 PowerShell 的 Expand-Archive（系统内置，无额外依赖）。
const extractDir = join(tmpDir, 'node-extract');
await rm(extractDir, { recursive: true, force: true });
await mkdir(extractDir, { recursive: true });
const zipName = `node-${pick.version}-win-x64.zip`;
await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Expand-Archive -LiteralPath '${zipName}' -DestinationPath 'node-extract' -Force`], { cwd: tmpDir });
const inner = (await readdir(extractDir))[0];
const nodeExe = join(extractDir, inner, 'node.exe');
const npmDir = join(extractDir, inner, 'node_modules', 'npm');
const dest = join(binDir, `node-${TRIPLE}.exe`);
await cp(nodeExe, dest); // 复制而非移动：.tmp/node/ 还要留一份给 stage-server 安装生产依赖
await rm(join(tmpDir, 'node'), { recursive: true, force: true });
await cp(npmDir, join(tmpDir, 'node', 'node_modules', 'npm'), { recursive: true });
await cp(join(extractDir, inner, 'node.exe'), join(tmpDir, 'node', 'node.exe'));
await rm(extractDir, { recursive: true, force: true });
console.log(`[fetch-node] sidecar -> ${dest}`);

async function exists(p) {
  try { await import('node:fs/promises').then((fs) => fs.stat(p)); return true; } catch { return false; }
}
