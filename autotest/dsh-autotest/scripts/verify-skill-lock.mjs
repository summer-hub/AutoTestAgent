// 技能供应链锁自检（verify:skill-lock，离线可跑，只读真实 skills/，篡改测试在临时副本上进行）：
//  1. 仓库 skills/ 与 skills-lock.json 一致（verified = 锁内技能数，无异常项）
//  2. 篡改检出：副本改一个字节 → 该技能 tampered 且 changedFiles 指到具体文件
//  3. 新增未锁定：副本加一个新技能 → unlocked
//  4. 缺失检出：副本删一个技能 → missing
//  5. 无锁文件：全部 unlocked 且 lockFile=null
//  6. isSkillTrusted：enforce=false 时 tampered 仍放行（仅告警）；enforce=true 时拒绝、verified 放行
// 用法：npm run build && npm run verify:skill-lock
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { verifySkillLock, isSkillTrusted, skillsRoot } = await import('../lib/services/skillLock.js');
const { setSetting } = await import('../lib/services/settings.js');

// ---------- 1. 真实仓库 skills/ 与锁一致 ----------
const realRoot = skillsRoot();
check(realRoot !== null, '解析到 skills 目录（仓库/独立版布局）', String(realRoot));
const real = verifySkillLock();
check(real.lockFile !== null, '锁文件存在', String(real.lockFile));
check(real.checked > 0 && real.verified === real.checked, '全部技能 digest 一致', `verified=${real.verified}/${real.checked}`);
check(real.tampered.length === 0 && real.unlocked.length === 0 && real.missing.length === 0, '无 tampered/unlocked/missing',
  `tampered=${real.tampered.length} unlocked=${real.unlocked.length} missing=${real.missing.length}`);
check(real.enforce === false, '默认 skills.lockEnforce=false（告警不拦截）');

// ---------- 临时副本工厂（篡改测试绝不碰真实 skills/） ----------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-skilllock-'));
const copyName = process.argv.includes('--copy') ? null : 'copy';
function makeCopy(name = 'copy') {
  const dest = path.join(tmpRoot, name);
  fs.cpSync(realRoot, dest, { recursive: true });
  return dest;
}

// ---------- 2. 篡改检出 ----------
{
  const copy = makeCopy('tampered');
  const victim = fs.readdirSync(copy).find((n) => fs.statSync(path.join(copy, n)).isDirectory());
  fs.appendFileSync(path.join(copy, victim, 'SKILL.md'), '\n<!-- tampered by self-check -->\n');
  process.env.AUTOTEST_SKILLS_DIR = copy;
  const r = verifySkillLock();
  const s = r.skills.find((x) => x.name === victim);
  check(s?.status === 'tampered', `篡改检出：${victim} → tampered`);
  check(s?.changedFiles.includes('SKILL.md') === true, 'changedFiles 指到被改文件', (s?.changedFiles ?? []).join(','));
  check(r.tampered.includes(victim), '报告 tampered 列表包含该技能');
}

// ---------- 3. 新增未锁定 ----------
{
  const copy = makeCopy('unlocked');
  fs.mkdirSync(path.join(copy, 'evil-new-skill'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'evil-new-skill', 'SKILL.md'), '---\nname: evil-new-skill\ndescription: 未锁定新技能\n---\n# x\n');
  process.env.AUTOTEST_SKILLS_DIR = copy;
  const r = verifySkillLock();
  check(r.unlocked.includes('evil-new-skill'), '新增未锁定技能 → unlocked', r.unlocked.join(','));
  check(r.skills.find((x) => x.name === 'evil-new-skill')?.status === 'unlocked', '该技能状态为 unlocked');
}

// ---------- 4. 缺失检出 ----------
{
  const copy = makeCopy('missing');
  const victim = fs.readdirSync(copy).find((n) => fs.statSync(path.join(copy, n)).isDirectory());
  fs.rmSync(path.join(copy, victim), { recursive: true, force: true });
  process.env.AUTOTEST_SKILLS_DIR = copy;
  const r = verifySkillLock();
  check(r.missing.includes(victim), `缺失检出：${victim} → missing`, r.missing.join(','));
}

// ---------- 5. 无锁文件 ----------
{
  const copy = makeCopy('nolock');
  fs.rmSync(path.join(copy, 'skills-lock.json'), { force: true });
  process.env.AUTOTEST_SKILLS_DIR = copy;
  const r = verifySkillLock();
  check(r.lockFile === null, '无锁文件时 lockFile=null');
  check(r.unlocked.length === r.checked && r.checked > 0, '无锁文件时全部技能 unlocked', `unlocked=${r.unlocked.length}/${r.checked}`);
}

// ---------- 6. isSkillTrusted（enforce 语义） ----------
{
  const copy = makeCopy('enforce');
  const victim = fs.readdirSync(copy).find((n) => fs.statSync(path.join(copy, n)).isDirectory());
  const good = fs.readdirSync(copy).filter((n) => n !== victim && fs.statSync(path.join(copy, n)).isDirectory())[0];
  fs.appendFileSync(path.join(copy, victim, 'SKILL.md'), '\n<!-- tampered -->\n');
  process.env.AUTOTEST_SKILLS_DIR = copy;

  setSetting('skills.lockEnforce', false);
  check(isSkillTrusted(victim) === true, 'enforce=false：被篡改技能仍放行（仅告警，兼容优先）');
  check(isSkillTrusted(good) === true, 'enforce=false：正常技能放行');

  setSetting('skills.lockEnforce', true);
  check(isSkillTrusted(victim) === false, 'enforce=true：被篡改技能拒绝加载');
  check(isSkillTrusted(good) === true, 'enforce=true：digest 一致的技能放行');
  check(isSkillTrusted('no-such-skill') === false, '不存在的技能拒绝');
  const r = verifySkillLock();
  check(r.enforce === true, '报告 expose enforce=true');

  setSetting('skills.lockEnforce', false); // 复位
}

// ---------- 汇总 ----------
delete process.env.AUTOTEST_SKILLS_DIR;
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
