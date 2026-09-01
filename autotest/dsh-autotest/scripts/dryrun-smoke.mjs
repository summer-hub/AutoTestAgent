// dry-run 执行器冒烟：在在线设备上真跑一组步骤，验证「执行器为真」链路可用。
// 用法：node scripts/dryrun-smoke.mjs [步骤1] [步骤2] ...
// 不带步骤参数时只 dump 当前界面控件清单，便于据此设计可执行的步骤。
import { listTargets, parseNodes, uiDump } from '../lib/services/hdc.js';
import { dryRunCase, mergeFailureBriefs } from '../lib/services/dryRun.js';

const [serial] = await listTargets();
if (!serial) {
  console.log('未检测到在线设备，退出');
  process.exit(1);
}
console.log(`设备：${serial}`);

const texts = [...new Set(parseNodes(await uiDump(serial)).map((n) => (n.text || n.desc || '').trim()).filter(Boolean))];
console.log(`界面可见控件（${texts.length}）：${texts.slice(0, 30).join(' | ')}`);

const steps = process.argv.slice(2);
if (steps.length === 0) {
  console.log('\n未指定步骤，仅 dump 界面。示例：node scripts/dryrun-smoke.mjs "等待 2 秒" "验证「设置」"');
  process.exit(0);
}

const r = await dryRunCase('SMOKE-001', '冒烟用例', steps, serial, { perStepTimeoutMs: 15000, failStreakStop: 2 });
console.log('\n---- 执行轨迹 ----');
for (const l of r.logs) console.log(l);
console.log(`\n结果：${r.passed ? '通过' : '失败'}`);
if (r.failureBrief) {
  console.log('\n---- 失败简报（回灌 LLM 的内容）----');
  console.log(r.failureBrief);
}
console.log('\n---- mergeFailureBriefs 合并输出 ----');
console.log(mergeFailureBriefs([{ caseNo: 'SMOKE-001', name: '冒烟用例', brief: r.failureBrief }]) || '（无失败，空）');
