// Hypium 工程布局与命名契约的自检（无设备、无 LLM；用临时工作区，不碰用户数据）。
//
// 这套钉的是"多库维护性"赖以成立的那几条硬约定 —— 任何一条破了，库一多就会到处出问题：
//   ① 单工程 + 库命名空间：所有库共用 <workspace>/hypium/，骨架只有一份；
//   ② 骨架只补缺不覆盖：手写过 main.py / aw/ 之后，生成器再跑不能改动它；
//   ③ 文件名 = Python 类名 = -l 模块名 = 报告里的模块名（四方一致）；
//   ④ 每个用例**成对**产出 .py + .json，且 json 的 driver.py_file 指向正确；
//   ⑤ 判据断言模块在共享 aw/ 包里（不是散在各库目录）；
//   ⑥ 旧布局（每库一个工程）能被迁移，不静默丢脚本。
//
// 用法：npm run build && npm run verify:hypium-layout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须指向临时工作区：绝不能碰用户正在用的 workspace/hypium
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-hypium-ws-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-hypium-db-'));
process.env.AUTOTEST_WORKSPACE = tmpWs;
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

const {
  hypiumProjectDir, hypiumLibDir, hypiumCaseScriptPath, hypiumCaseJsonPath, hypiumAwDir, hypiumBaselineDir,
  hypiumCaseModule, hypiumLibSlug, hypiumCaseSlug, caseClassName, caseJsonContent,
  generateCaseScript, writeCaseScript, oracleSupportModuleSource, ensureHypiumProject, migrateLegacyHypiumLayouts,
} = await import('../lib/services/hypiumGen.js');

const LIB = { name: 'json-schema', packageName: 'com.openharmony.jsonschemavalidator' };
const CASE = {
  caseNo: 'C-JS-001', name: '校验通过',
  steps: ['打开应用', '点击「验证」', '验证「实际结果：true」'],
  oracles: [{ type: 'control_text', control: '实际结果：true' }],
};

// ---------- 1. 命名契约 ----------
console.log('— 命名契约（文件名 = 类名 = -l 模块名）—');
eq(hypiumLibSlug('json-schema'), 'json_schema', '库名 slug：- 与 . 归一为 _');
eq(hypiumLibSlug('lottie.turbo'), 'lottie_turbo', '库名 slug：点号也归一');
eq(hypiumLibSlug('3rd-lib'), 'lib_3rd_lib', '库名以数字开头时补前缀（Python 标识符不能以数字开头）');
eq(hypiumCaseSlug('C-JS-001'), 'C_JS_001', '用例编号 slug：- 归一为 _');
eq(hypiumCaseModule('json-schema', 'C-JS-001'), 'json_schema_C_JS_001', '模块名 = <lib>_<caseNo>');
eq(caseClassName('json-schema', 'C-JS-001'), hypiumCaseModule('json-schema', 'C-JS-001'), '类名与模块名同源（不允许各处自己拼）');
check(/^[A-Za-z_]\w*$/.test(hypiumCaseModule('json-schema', 'C-JS-001')), '模块名是合法 Python 标识符');

// ---------- 2. 单工程 + 库命名空间 ----------
console.log('\n— 单工程 + 库命名空间 —');
const root = hypiumProjectDir();
check(root === path.join(tmpWs, 'hypium'), '工程根是共享的 <workspace>/hypium', root);
eq(hypiumProjectDir('随便哪个库'), root, '传入库名也不改变工程根（库只体现在 testcases/<lib>/）');
eq(hypiumLibDir('json-schema'), path.join(root, 'testcases', 'json_schema'), '库目录 = testcases/<lib>');
eq(hypiumCaseScriptPath('json-schema', 'C-JS-001'), path.join(root, 'testcases', 'json_schema', 'json_schema_C_JS_001.py'), '脚本路径');
eq(hypiumCaseJsonPath('json-schema', 'C-JS-001'), path.join(root, 'testcases', 'json_schema', 'json_schema_C_JS_001.json'), 'json 与脚本同名同目录');
eq(hypiumAwDir(), path.join(root, 'aw'), '共享工具目录 aw/');
eq(hypiumBaselineDir(), path.join(root, 'resource', 'baseline'), '基线目录统一到 resource/baseline');

// ---------- 3. 骨架：只补缺不覆盖 ----------
console.log('\n— 骨架（只补缺，绝不覆盖手写内容）—');
ensureHypiumProject(LIB, 'LNG0224718005504');
const skeleton = ['main.py', 'run.bat', 'run.sh', '.gitignore', path.join('aw', '__init__.py'), path.join('aw', 'Utils.py')];
for (const rel of skeleton) check(fs.existsSync(path.join(root, rel)), `骨架已生成 ${rel}`);
const cfg = fs.readFileSync(path.join(root, 'config', 'user_config.xml'), 'utf8');
check(cfg.includes('LNG0224718005504'), 'user_config.xml 写入设备 sn（执行前刷新）');
check(fs.readFileSync(path.join(root, 'main.py'), 'utf8').includes('sys.argv'), 'main.py 从 argv 取模块名（一条命令跑一个用例）');

const handwritten = '# 人手写的等待函数，生成器不许动\n';
fs.writeFileSync(path.join(root, 'aw', 'Utils.py'), handwritten, 'utf8');
fs.writeFileSync(path.join(root, 'main.py'), handwritten, 'utf8');
ensureHypiumProject(LIB);
eq(fs.readFileSync(path.join(root, 'aw', 'Utils.py'), 'utf8'), handwritten, '★ 手写过的 aw/Utils.py 不被覆盖');
eq(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), handwritten, '★ 手写过的 main.py 不被覆盖');
// 复原，后续步骤要用真骨架
fs.writeFileSync(path.join(root, 'main.py'), '# restored\n', 'utf8');

// ★ 判据模块是**生成物**（不是团队手写的骨架）：必须每次刷新。
//   否则"修好的断言"永远进不了已存在的工程 —— 200+ 个库时就是每个库一套旧断言。
const supportPath = path.join(hypiumAwDir(), 'autotest_oracle.py');
fs.writeFileSync(supportPath, '# 假的旧版本断言模块（模拟"已存在的工程里是旧实现"）\n', 'utf8');
writeCaseScript(LIB, CASE);
const supportNow = fs.readFileSync(supportPath, 'utf8');
check(supportNow.includes('_read_run_log'), '★ 判据模块被刷新（生成物归生成器所有，修复能到达已有工程）');
check(supportNow.includes('不要手改'), '判据模块头部声明"由生成器维护、不要手改"（给出定制出路）');

// ---------- 4. 成对产出 .py + .json ----------
console.log('\n— 成对产出脚本与 xdevice 配置 —');
const script = generateCaseScript(LIB, CASE);
const json = JSON.parse(caseJsonContent(LIB, CASE));
eq(json.driver.py_file, ['json_schema/json_schema_C_JS_001.py'], 'json 的 driver.py_file 指向脚本（相对 testcases/）');
eq(json.environment, [{ type: 'device', label: 'phone' }], 'json 的 environment 与模板一致');
check(String(json.description).includes('C-JS-001'), 'json 描述里带用例编号（人可核对）');

const written = writeCaseScript(LIB, CASE);
eq(written, hypiumCaseScriptPath('json-schema', 'C-JS-001'), 'writeCaseScript 返回脚本路径');
check(fs.existsSync(hypiumCaseJsonPath('json-schema', 'C-JS-001')), '★ .json 与 .py 成对落盘');
check(script.includes('class json_schema_C_JS_001(TestCase):'), '脚本里的类名 = 模块名');
check(script.includes('from aw.autotest_oracle import ('), '脚本从 aw/ 包 import 判据断言模块');
check(fs.existsSync(path.join(hypiumAwDir(), 'autotest_oracle.py')), '判据断言模块落在 aw/ 而不是各库目录');

// ---------- 5. 多库共存不串 ----------
console.log('\n— 多库共存（命名空间隔离）—');
writeCaseScript({ name: 'lottie-turbo', packageName: 'com.openharmony.lottieturbo' },
  { caseNo: 'C-LT-007', name: '图片回调', steps: ['打开应用', '点击「开始」'], oracles: [{ type: 'no_crash' }] });
const libs = fs.readdirSync(path.join(root, 'testcases')).sort();
eq(libs, ['json_schema', 'lottie_turbo'], '两个库各自一个目录，互不覆盖');
check(fs.existsSync(path.join(root, 'testcases', 'lottie_turbo', 'lottie_turbo_C_LT_007.json')), '第二个库的 json 也成对落盘');
// 判据模块不重复：aw/ 里只有一份
eq(fs.readdirSync(hypiumAwDir()).filter((f) => f === 'autotest_oracle.py').length, 1, 'aw/ 里的判据模块只有一份（不是每库一份）');
check(oracleSupportModuleSource().includes('resource') && oracleSupportModuleSource().includes('baseline'),
  '判据模块的基线目录指向 resource/baseline（与框架 zip 同目录）');

// ---------- 6. 旧布局迁移 ----------
console.log('\n— 旧布局迁移（每库一个工程 → 单工程）—');
const legacyLib = path.join(root, 'legacy-lib');
fs.mkdirSync(path.join(legacyLib, 'testcases', 'legacy_lib'), { recursive: true });
fs.mkdirSync(path.join(legacyLib, 'config'), { recursive: true });
fs.writeFileSync(path.join(legacyLib, 'main.py'), '# legacy skeleton\n', 'utf8');
fs.writeFileSync(path.join(legacyLib, 'autotest_oracle.py'), '# legacy support\n', 'utf8');
fs.writeFileSync(path.join(legacyLib, 'config', 'user_config.xml'), '<x/>', 'utf8');
fs.writeFileSync(path.join(legacyLib, 'testcases', 'legacy_lib', 'legacy_lib_C_L1_001.py'), '# legacy case\n', 'utf8');
fs.writeFileSync(path.join(legacyLib, 'README-同事写的.md'), '# 人写的说明，不许删\n', 'utf8');

const mig = migrateLegacyHypiumLayouts();
check(fs.existsSync(path.join(root, 'testcases', 'legacy_lib', 'legacy_lib_C_L1_001.py')), '★ 旧工程的用例脚本被搬到共享 testcases/');
check(!fs.existsSync(path.join(legacyLib, 'main.py')), '旧骨架文件被清理');
check(fs.existsSync(path.join(legacyLib, 'README-同事写的.md')), '★ 非骨架文件（人写的说明）保留');
check(mig.files >= 1, '迁移报告写明搬运文件数', JSON.stringify(mig));

fs.rmSync(tmpWs, { recursive: true, force: true });
console.log(fail === 0 ? '\n全部自检通过' : `\n自检失败：${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
