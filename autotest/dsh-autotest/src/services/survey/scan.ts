// survey 扫描层：把磁盘上的仓库采成 RawRepoScan（IO 与纯函数的分界）。
//
// 为什么单独一层：facts.ts 是纯函数（可离线自检），本文件只负责"把仓库读出来"。
// 分开之后，"为什么判成 animation"可以在自检里用假数据逐条核对，
// 而"仓库没 clone / 目录不存在"这类 IO 失败有独立的失败分类。
//
// 三条纪律：
//   1. **只读**：扫描绝不写仓库（补丁那套副本机制在 testability.ts，与这里无关）；
//   2. **有界**：文件数、单文件大小、README 长度都设上限——348 个库里难免有巨型仓库，
//      一个库把流水线拖死会连带整批超时；
//   3. **跳过构建产物**：node_modules / oh_modules / .git / build / .hvigor 一律不进 file 列表，
//      否则"文件数"这个指标会被依赖目录污染得毫无意义。
import fs from 'node:fs';
import path from 'node:path';
import type { RawRepoScan } from './facts.js';

/** 扫描上限（防止个别巨型仓库拖死整批）。 */
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 超过 2MB 的文件不读内容（只登记路径）
const MAX_README_CHARS = 200000;
const MAX_DEPTH = 12;

/** 构建产物与依赖目录：不进扫描结果。 */
const SKIP_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', 'build', '.hvigor', '.idea', 'dist',
  '.cxx', 'out', 'target', '__pycache__', '.gradle', 'Pods', 'DerivedData',
]);

/** 二进制产物后缀。 */
const BINARY_RE = /\.(so|a|lib|dll|dylib)$/i;

/** JSON5 宽松解析：去行注释/块注释/尾逗号。鸿蒙工程普遍带注释，标准 JSON.parse 会炸。 */
function parseJson5Loose(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    const v = JSON.parse(cleaned);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextSafe(file: string, maxBytes = MAX_FILE_BYTES): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 递归收集相对路径（跳过构建产物目录，深度与数量有上限）。 */
function walkFiles(root: string, rel = '', depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkFiles(root, relPath, depth + 1, out);
    } else if (e.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/** 读 README（多个常见名字按优先级拼接，总量有上限）。 */
function readReadme(root: string): string {
  const names = ['README.md', 'readme.md', 'README-zh.md', 'README_zh.md', 'README.MD', 'Readme.md', 'README'];
  const parts: string[] = [];
  let total = 0;
  for (const n of names) {
    const t = readTextSafe(path.join(root, n), 1024 * 1024);
    if (!t) continue;
    parts.push(t);
    total += t.length;
    if (total >= MAX_README_CHARS) break;
  }
  return parts.join('\n\n').slice(0, MAX_README_CHARS);
}

function readOhPackage(root: string): RawRepoScan['ohPackage'] {
  const text = readTextSafe(path.join(root, 'oh-package.json5')) || readTextSafe(path.join(root, 'oh-package.json'));
  if (!text) return null;
  const o = parseJson5Loose(text);
  if (!o) return null;
  const deps = (o.dependencies ?? o.devDependencies ?? {}) as Record<string, unknown>;
  const dependencies: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps)) {
    if (typeof v === 'string') dependencies[k] = v;
  }
  return { name: String(o.name ?? ''), version: String(o.version ?? ''), dependencies };
}

function readBuildProfile(root: string): RawRepoScan['buildProfile'] {
  const text = readTextSafe(path.join(root, 'build-profile.json5'));
  if (!text) return null;
  const o = parseJson5Loose(text);
  if (!o) return null;
  const modules: string[] = [];
  const rawModules = o.modules;
  if (Array.isArray(rawModules)) {
    for (const m of rawModules) {
      if (m && typeof m === 'object' && typeof (m as Record<string, unknown>).name === 'string') {
        modules.push(String((m as Record<string, unknown>).name));
      }
    }
  }
  const app = (o.app ?? {}) as Record<string, unknown>;
  const bundleName = String(app.bundleName ?? '');
  let apiLevel = '';
  const products = app.products;
  if (Array.isArray(products) && products[0] && typeof products[0] === 'object') {
    const p = products[0] as Record<string, unknown>;
    apiLevel = String(p.targetSdkVersion ?? p.compatibleSdkVersion ?? '');
  }
  return { modules, bundleName, apiLevel };
}

export interface ScanResult {
  ok: boolean;
  scan?: RawRepoScan;
  reason?: string;
  /** 扫描到的文件数（诊断用） */
  fileCount?: number;
}

/**
 * 扫描仓库目录。目录不存在/不可读 → ok=false + reason（调用方记失败分类）。
 * 注意：仓库未 clone 是**常见且预期**的情况（348 个库不可能全部 clone），
 * 上层应把它归成"待拉取"而不是错误。
 */
export function scanRepo(repoDir: string, libraryName: string): ScanResult {
  if (!repoDir || !fs.existsSync(repoDir)) {
    return { ok: false, reason: `仓库目录不存在：${repoDir || '(空)'}（需先拉取代码）` };
  }
  let st: fs.Stats;
  try { st = fs.statSync(repoDir); } catch { return { ok: false, reason: `无法读取目录：${repoDir}` }; }
  if (!st.isDirectory()) return { ok: false, reason: `不是目录：${repoDir}` };

  const files = walkFiles(repoDir);
  const binaryFiles = files.filter((f) => BINARY_RE.test(f));
  const scan: RawRepoScan = {
    files,
    readme: readReadme(repoDir),
    ohPackage: readOhPackage(repoDir),
    buildProfile: readBuildProfile(repoDir),
    gitmodules: readTextSafe(path.join(repoDir, '.gitmodules'), 64 * 1024),
    binaryFiles,
    libraryName,
  };
  return { ok: true, scan, fileCount: files.length };
}
