// 生成技能供应链锁文件（skills-lock.json）——仓库根工具脚本，零依赖。
//
// 背景：skills/ 下的 SKILL.md 会被 AI agent 直接读取并作为指令执行（prompt 注入面）。
// 没有锁文件时，任何改动（有意升级或恶意篡改）都无痕。锁文件把每个技能的文件清单
// 与逐文件 SHA-256 固化，服务端启动/查询时比对（见 dsh-autotest/src/services/skillLock.ts），
// 篡改可检出；skills.lockEnforce=true 时被篡改的技能拒绝加载。
//
// 用法（仓库根执行）：
//   node scripts/gen-skills-lock.mjs           # 重新生成（技能升级后必须重跑并提交）
//   node scripts/gen-skills-lock.mjs --check   # 只校验不写盘（CI 门禁用，不一致 exit 1）
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(root, 'skills');
const lockFile = join(skillsDir, 'skills-lock.json');
const CHECK_MODE = process.argv.includes('--check');

if (!existsSync(skillsDir)) {
  console.error(`[skills-lock] skills 目录不存在：${skillsDir}`);
  process.exit(1);
}

/** 递归收集目录下所有文件（相对路径，POSIX 分隔符）。 */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full, base, out); continue; }
    out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const skills = {};
for (const name of readdirSync(skillsDir).sort()) {
  const dir = join(skillsDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const files = {};
  for (const rel of walk(dir)) {
    files[rel] = sha256(readFileSync(join(dir, rel)));
  }
  // digest = 全部「路径\0哈希」按序拼接后的 SHA-256（顺序无关，内容一字节变即变）
  const digest = sha256(Object.entries(files).map(([p, h]) => `${p}\u0000${h}\n`).join(''));
  skills[name] = { digest, files };
}

const lock = {
  version: 1,
  algorithm: 'sha256',
  generatedAt: new Date().toISOString(),
  skills,
};

if (CHECK_MODE) {
  if (!existsSync(lockFile)) {
    console.error('[skills-lock] 锁文件不存在（请先 node scripts/gen-skills-lock.mjs）');
    process.exit(1);
  }
  const current = JSON.parse(readFileSync(lockFile, 'utf8'));
  const a = JSON.stringify(current.skills, Object.keys(current.skills).sort());
  const b = JSON.stringify(lock.skills, Object.keys(lock.skills).sort());
  if (a !== b) {
    console.error('[skills-lock] ❌ 锁文件与 skills/ 实际内容不一致——技能被改动过。若是主动升级，请重新生成锁文件并提交；若是被篡改，请核查。');
    for (const name of Object.keys(lock.skills)) {
      const cur = current.skills?.[name];
      if (!cur) { console.error(`  新增技能：${name}`); continue; }
      if (cur.digest !== lock.skills[name].digest) {
        for (const [f, h] of Object.entries(lock.skills[name].files)) {
          if (cur.files?.[f] !== h) console.error(`  变更：${name}/${f}`);
        }
      }
    }
    process.exit(1);
  }
  console.log(`[skills-lock] ✅ 锁文件与 ${Object.keys(lock.skills).length} 个技能一致`);
  process.exit(0);
}

writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`[skills-lock] 已生成 ${lockFile}（${Object.keys(skills).length} 个技能）`);
for (const [name, s] of Object.entries(skills)) {
  console.log(`  ${name}  digest=${s.digest.slice(0, 12)}…  files=${Object.keys(s.files).length}`);
}
