// 架构治理门禁（P1-1）：把 architecture-policy.yaml 固化的五条约束变成机器检查。
// 用法：npm run verify:architecture（CI 门禁，违规 exit 1）
//
// 与 YAML 的防漂移：dshDecoupling 白名单从 YAML 原文正则提取，与脚本内置表比对——
// 改规则只改一处会直接FAIL，逼着两边同步。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const autotestRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); // …/autotest
const policyFile = join(autotestRoot, 'architecture-policy.yaml');

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const posix = (p) => relative(autotestRoot, p).split('\\').join('/');

/** 递归收集目录内指定扩展名文件。 */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full, exts, out); continue; }
    if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** 提取 import 说明符：静态（import/export…from）与动态（await import()）分开。 */
function extractImports(src) {
  const static_ = [];
  const dynamic = [];
  const staticRe = /(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynRe = /(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(staticRe)) static_.push(m[1]);
  for (const m of src.matchAll(dynRe)) dynamic.push(m[1]);
  return { static: static_, dynamic };
}

/** 把相对说明符解析为相对 autotestRoot 的 POSIX 路径（跨不出 autotest 返回 null）。 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = resolve(dirname(fromFile), spec);
  const rel = posix(abs);
  return rel.startsWith('..') ? null : rel;
}

// ---------- 规则 1：DSH 解耦（白名单外零 @deepseek-ai） ----------
const serverSrc = join(autotestRoot, 'dsh-autotest', 'src');
const YAML_WHITELIST = (() => {
  if (!existsSync(policyFile)) return null;
  const txt = readFileSync(policyFile, 'utf8');
  const block = txt.match(/dshDecoupling:[\s\S]*?allow:\s*\n((?:\s+- .*\n?)*)/);
  if (!block) return null;
  return [...block[1].matchAll(/-\s+(\S+)/g)].map((m) => m[1]);
})();
const SCRIPT_WHITELIST = [
  'dsh-autotest/src/index.ts',
  'dsh-autotest/src/client/**',
  'dsh-autotest/src/services/llmHarness.ts',
];
check(YAML_WHITELIST !== null, 'architecture-policy.yaml 存在且含 dshDecoupling 白名单', String(policyFile));
check(
  YAML_WHITELIST !== null && JSON.stringify([...YAML_WHITELIST].sort()) === JSON.stringify([...SCRIPT_WHITELIST].sort()),
  'YAML 与审计脚本白名单一致（防漂移）',
  `yaml=${JSON.stringify(YAML_WHITELIST)}`,
);

// layering 例外：YAML 与脚本双边维护，漂移即 FAIL（改规则必须同步两处）
const YAML_LAYER_EXC = (() => {
  if (!existsSync(policyFile)) return null;
  const txt = readFileSync(policyFile, 'utf8');
  const block = txt.match(/layering:[\s\S]*?exceptions:\s*\n((?:\s+- "[^"]*"\n?)*)/);
  if (!block) return [];
  return [...block[1].matchAll(/-\s+"([^"]+)"/g)].map((m) => m[1]);
})();
const SCRIPT_LAYER_EXC = ['dsh-autotest/src/db/repository.ts -> dsh-autotest/src/services/settings.js'];
check(
  YAML_LAYER_EXC !== null && JSON.stringify([...YAML_LAYER_EXC].sort()) === JSON.stringify([...SCRIPT_LAYER_EXC].sort()),
  'YAML 与审计脚本 layering 例外一致（防漂移）',
  `yaml=${JSON.stringify(YAML_LAYER_EXC)}`,
);
const LAYER_EXC_SET = new Set(SCRIPT_LAYER_EXC);

function inWhitelist(rel) {
  return SCRIPT_WHITELIST.some((w) => w.endsWith('/**') ? rel.startsWith(w.slice(0, -2)) : rel === w);
}

{
  const files = walk(serverSrc, ['.ts']).filter((f) => !posix(f).startsWith('dsh-autotest/src/client/'));
  const violations = [];
  for (const f of files) {
    const rel = posix(f);
    if (inWhitelist(rel)) continue;
    const { static: s, dynamic: d } = extractImports(readFileSync(f, 'utf8'));
    for (const spec of [...s, ...d]) {
      if (spec.startsWith('@deepseek-ai')) violations.push(`${rel} → ${spec}`);
    }
  }
  check(violations.length === 0, 'DSH 解耦：白名单外零 @deepseek-ai import',
    violations.length ? violations.join('; ') : `（${files.length} 个文件全检）`);
}

// ---------- 规则 2：shared 仅类型 ----------
{
  const files = walk(join(autotestRoot, 'shared', 'src'), ['.ts']);
  const violations = [];
  for (const f of files) {
    const rel = posix(f);
    const src = readFileSync(f, 'utf8');
    const { static: s } = extractImports(src);
    for (const spec of s) {
      if (spec.startsWith('node:') || ['fs', 'path', 'os', 'crypto', 'http'].includes(spec)) violations.push(`${rel} → node 内置 ${spec}`);
    }
    if (/^export\s+(?:async\s+)?(?:function|class)\b/m.test(src)) violations.push(`${rel} 含运行时导出（function/class）`);
    if (/^export\s+(?:const|let|var)\s+\w+\s*=[^=]/m.test(src)) violations.push(`${rel} 含运行时导出（const/let/var）`);
  }
  check(files.length > 0 && violations.length === 0, 'shared 仅类型：无 node 内置依赖、无运行时导出',
    violations.length ? violations.join('; ') : `（${files.length} 个文件）`);
}

// ---------- 规则 3：web 隔离（只准 shared 跨包） ----------
{
  const webSrc = join(autotestRoot, 'web', 'src');
  const files = walk(webSrc, ['.ts', '.tsx']);
  const violations = [];
  for (const f of files) {
    const rel = posix(f);
    const { static: s } = extractImports(readFileSync(f, 'utf8'));
    for (const spec of s) {
      if (spec === 'shared') continue;
      if (spec.startsWith('.')) {
        const target = resolveSpec(f, spec);
        if (target === null || !target.startsWith('web/')) violations.push(`${rel} → 越界相对引用 ${spec}（解析到 ${target ?? 'autotest 外'}）`);
        continue;
      }
      // 裸说明符：取**包名**（scoped 包 @a/b 取前两段，其余取第一段——'react-dom/client'
      // 这类子路径导入的包名是 react-dom，拼整串会查不到从而误报），在 web/node_modules
      // 或提升的根 node_modules（npm workspace 惯例）里查。
      const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!existsSync(join(autotestRoot, 'web', 'node_modules', pkgName)) && !existsSync(join(autotestRoot, 'node_modules', pkgName))) {
        violations.push(`${rel} → 未安装的内部/裸包引用 ${spec}`);
      }
    }
  }
  check(violations.length === 0, 'web 隔离：跨包只准 shared，禁碰服务端内部',
    violations.length ? violations.join('; ') : `（${files.length} 个文件）`);
}

// ---------- 规则 4：desktop 隔离（Rust 不反向引用源码目录） ----------
{
  const rustSrc = join(autotestRoot, 'desktop', 'src-tauri', 'src');
  const files = walk(rustSrc, ['.rs']);
  const violations = [];
  for (const f of files) {
    const rel = posix(f);
    const src = readFileSync(f, 'utf8');
    if (src.includes('dsh-autotest/src') || src.includes('web/src')) violations.push(`${rel} 反向引用 web/src 或 dsh-autotest/src`);
    if (/include!\s*\(\s*["'][^"']*\.\.[/\\]/.test(src)) violations.push(`${rel} 含越界 include!`);
  }
  check(violations.length === 0, 'desktop 隔离：Rust 壳不引用 web/服务端源码（产物只经 staging 脚本）',
    violations.length ? violations.join('; ') : `（${files.length} 个文件）`);
}

// ---------- 规则 5：分层顺序（db → services → api，静态引用不准向上） ----------
{
  const layerOf = (rel) =>
    rel.startsWith('dsh-autotest/src/db/') ? 'db'
      : rel.startsWith('dsh-autotest/src/services/') ? 'services'
        : rel.startsWith('dsh-autotest/src/api/') ? 'api' : 'entry';
  const upper = { db: ['services', 'api'], services: ['api'] };
  const files = walk(serverSrc, ['.ts']).filter((f) => {
    const l = layerOf(posix(f));
    return l === 'db' || l === 'services';
  });
  const violations = [];
  for (const f of files) {
    const rel = posix(f);
    const me = layerOf(rel);
    const { static: s } = extractImports(readFileSync(f, 'utf8'));
    for (const spec of s) {
      const target = resolveSpec(f, spec);
      if (!target || !target.startsWith('dsh-autotest/src/')) continue;
      const tl = layerOf(`${target.replace(/\.js$/, '.ts')}`);
      // 已登记例外（YAML layering.exceptions，双边防漂移）跳过
      if (LAYER_EXC_SET.has(`${rel} -> ${target}`)) continue;
      if (upper[me]?.includes(tl)) violations.push(`${rel}(${me}) → ${spec}(${tl})`);
    }
  }
  check(violations.length === 0, '分层顺序：db/services 不准静态引用上层（动态 import 例外已记录）',
    violations.length ? violations.join('; ') : `（${files.length} 个文件）`);
}

// ---------- 汇总 ----------
console.log(fail === 0 ? '\n架构审计全部通过' : `\n架构审计 ${fail} 项违规`);
process.exit(fail === 0 ? 0 : 1);
