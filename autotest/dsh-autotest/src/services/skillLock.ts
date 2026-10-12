// 技能供应链校验（P1-2）：把 skills/ 实际内容与 skills-lock.json 逐文件比对。
//
// 威胁模型：SKILL.md 会被 AI agent 当指令读取执行（prompt 注入面）。锁文件由仓库根
// scripts/gen-skills-lock.mjs 生成（技能升级后必须重跑并提交），把每个技能的文件清单 +
// 逐文件 SHA-256 + 合并 digest 固化。运行期比对：
//   - verified   ：digest 一致；
//   - tampered   ：文件被改动（主动升级漏重跑锁 = tampered，恶意篡改也是 tampered——
//                  两者都要求"先重生成锁再提交"，流程上堵死"静默改技能"）；
//   - unlocked   ：目录里存在但锁文件中没有的技能（新增未锁定）；
//   - missing    ：锁文件里有但目录里没了的技能。
// skills.lockEnforce=true 时，tampered/unlocked 技能判为不可信（agent 绑定与技能加载应拒绝）。
//
// skills 目录解析顺序（覆盖四种部署形态）：
//   1. AUTOTEST_SKILLS_DIR 环境变量（显式指定，最高优先）
//   2. <包根>/skills            —— 桌面端 staged（resources/server/skills/）
//   3. <包根>/../../skills      —— 仓库开发/独立版同机布局（dsh-autotest → 仓库根）
//   4. <包根>/../skills         —— 单层上级
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting } from './settings.js';

export type SkillTrust = 'verified' | 'tampered' | 'unlocked' | 'missing';

export interface SkillLockStatus {
  name: string;
  status: SkillTrust;
  expectedDigest: string;
  actualDigest: string;
  changedFiles: string[];
}

export interface SkillLockReport {
  /** skills 目录绝对路径；未部署（插件安装形态且未随包）为 null */
  root: string | null;
  lockFile: string | null;
  /** skills.lockEnforce 设置值 */
  enforce: boolean;
  checked: number;
  verified: number;
  tampered: string[];
  unlocked: string[];
  missing: string[];
  skills: SkillLockStatus[];
}

function hasSkillMd(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'SKILL.md')));
  } catch {
    return false;
  }
}

/** skills 目录解析（覆盖部署形态，见文件头）。 */
export function skillsRoot(): string | null {
  const env = String(process.env.AUTOTEST_SKILLS_DIR ?? '').trim();
  if (env && (existsSync(join(env, 'skills-lock.json')) || hasSkillMd(env))) return resolve(env);
  // 本文件位于 <包根>/lib/services/ → 包根是 ../..（**不是 ../../..**：多一层会跳到包根上级，
  // 仓库布局下靠"多跳一层刚好落到仓库根"侥幸能跑，桌面端 staged 布局下直接找不到——实测踩过）。
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const candidates = [
    join(pkgRoot, 'skills'),              // 桌面端 staged（resources/server/skills/）
    join(pkgRoot, '..', '..', 'skills'),  // 仓库开发 / 独立版同机（dsh-autotest → 仓库根）
    join(pkgRoot, '..', 'skills'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'skills-lock.json')) || hasSkillMd(c)) return resolve(c);
  }
  return null;
}

function hashDir(dir: string): { digest: string; files: Record<string, string> } | null {
  if (!existsSync(dir)) return null;
  const files: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(dir, full).split('\\').join('/');
      files[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  // digest 算法与 gen-skills-lock.mjs 完全一致：路径\0哈希 按**码元序**（默认字符串排序）拼接后 SHA-256。
  // 注意不能用 localeCompare：区域感知排序对 'SKILL.md' vs 'scripts/...' 的大小写混合路径
  // 会给出与码元序不同的结果，digest 就会对不上（曾全量误报 tampered）。
  const digest = createHash('sha256').update(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, h]) => `${p}\u0000${h}\n`).join(''),
  ).digest('hex');
  return { digest, files };
}

function skillNames(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()).sort();
  } catch {
    return [];
  }
}

/** 全量校验（启动时打一次摘要；GET /skills 按需查）。 */
export function verifySkillLock(): SkillLockReport {
  const enforce = getSetting<boolean>('skills.lockEnforce', false) === true;
  const root = skillsRoot();
  if (!root) {
    return { root: null, lockFile: null, enforce, checked: 0, verified: 0, tampered: [], unlocked: [], missing: [], skills: [] };
  }
  const lockPath = join(root, 'skills-lock.json');
  const report: SkillLockReport = {
    root, lockFile: existsSync(lockPath) ? lockPath : null, enforce,
    checked: 0, verified: 0, tampered: [], unlocked: [], missing: [], skills: [],
  };

  const lock: { skills?: Record<string, { digest: string; files?: Record<string, string> }> } = existsSync(lockPath)
    ? ((): { skills?: Record<string, { digest: string; files?: Record<string, string> }> } => {
        try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return {}; }
      })()
    : {};
  const locked = lock.skills ?? {};

  for (const name of skillNames(root)) {
    const actual = hashDir(join(root, name));
    const expected = locked[name];
    report.checked += 1;
    if (!expected) {
      report.unlocked.push(name);
      report.skills.push({ name, status: 'unlocked', expectedDigest: '', actualDigest: actual?.digest ?? '', changedFiles: [] });
      continue;
    }
    const changedFiles: string[] = [];
    const actualFiles = actual?.files ?? {};
    for (const [f, h] of Object.entries(expected.files ?? {})) {
      if (actualFiles[f] !== h) changedFiles.push(f);
    }
    for (const f of Object.keys(actualFiles)) {
      if (!(expected.files ?? {})[f]) changedFiles.push(`${f}（新增文件）`);
    }
    if (actual && actual.digest === expected.digest) {
      report.verified += 1;
      report.skills.push({ name, status: 'verified', expectedDigest: expected.digest, actualDigest: actual.digest, changedFiles: [] });
    } else {
      report.tampered.push(name);
      report.skills.push({ name, status: 'tampered', expectedDigest: expected.digest, actualDigest: actual?.digest ?? '', changedFiles });
    }
  }
  for (const name of Object.keys(locked)) {
    if (!skillNames(root).includes(name)) report.missing.push(name);
  }
  return report;
}

/** enforce 模式下判定技能是否可信任（verified 才放行）。 */
export function isSkillTrusted(name: string): boolean {
  const report = verifySkillLock();
  const s = report.skills.find((x) => x.name === name);
  if (!s) return false;
  if (!report.enforce) return true; // 非 enforce：仅告警不拦截
  return s.status === 'verified';
}

/** 启动摘要（两个入口各调一次；不静默）。 */
export function logSkillLockSummary(): void {
  const r = verifySkillLock();
  if (!r.root) {
    console.log('[skills] 未发现 skills 目录（插件安装形态默认不随包）——AI 任务引用的 SKILL.md 将依赖部署方提供');
    return;
  }
  if (!r.lockFile) {
    console.warn(`[skills] ⚠️ ${r.root} 无 skills-lock.json：${r.checked} 个技能全部未锁定（供应链无防护）。请执行 node scripts/gen-skills-lock.mjs 生成并提交。`);
    return;
  }
  if (r.tampered.length || r.unlocked.length || r.missing.length) {
    console.warn(`[skills] ⚠️ 锁校验异常：verified=${r.verified} tampered=${r.tampered.join(',') || '无'} unlocked=${r.unlocked.join(',') || '无'} missing=${r.missing.join(',') || '无'}${r.enforce ? '（enforce=true，异常技能将拒绝加载）' : ''}`);
    for (const s of r.skills) {
      if (s.status !== 'verified') console.warn(`[skills]   ${s.name}: ${s.status}${s.changedFiles.length ? `（${s.changedFiles.join(', ')}）` : ''}`);
    }
    return;
  }
  console.log(`[skills] 锁校验通过：${r.verified}/${r.checked} 个技能 digest 一致（${r.lockFile}）`);
}
