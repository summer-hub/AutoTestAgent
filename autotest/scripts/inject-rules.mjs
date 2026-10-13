// 规则注入 CLI（B3-2）：本地开发工作流用（git hook / 编辑器 / 终端）。
// 服务端路由版（远程 agent 用）见 GET /rules/inject；本脚本直接读 rules/ 目录。
//
// 用法（autotest/ 下执行）：
//   node scripts/inject-rules.mjs --paths dsh-autotest/src/db/connection.ts
//   node scripts/inject-rules.mjs --touches transaction,secrets
//   node scripts/inject-rules.mjs --from-git            # 工作区变更（vs HEAD）
//   node scripts/inject-rules.mjs --from-git-staged     # 暂存区变更（pre-commit 用）
//   node scripts/inject-rules.mjs --from-git --budget 4000 --format json
//
// 前置：dsh-autotest 已构建（npm run build:lib）——注入逻辑复用 lib/services/rules.js。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libRules = path.join(root, 'dsh-autotest', 'lib', 'services', 'rules.js');

if (!fs.existsSync(libRules)) {
  console.error('[inject-rules] 缺少 lib/services/rules.js——请先 cd dsh-autotest && npm run build:lib');
  process.exit(1);
}

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : def;
};
const has = (name) => argv.includes(name);

const paths = (opt('--paths', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const touches = (opt('--touches', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const budget = Number(opt('--budget', '8000'));
const format = opt('--format', 'md') === 'json' ? 'json' : 'md';

const gitPaths = (mode) => {
  const args = mode === 'staged'
    ? ['diff', '--cached', '--name-only']
    : ['diff', '--name-only', 'HEAD'];
  const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
};

let changed = [...paths];
if (has('--from-git')) changed.push(...gitPaths('worktree'));
if (has('--from-git-staged')) changed.push(...gitPaths('staged'));
changed = [...new Set(changed)];

if (changed.length === 0 && touches.length === 0) {
  console.error('[inject-rules] 未指定输入：--paths / --touches / --from-git / --from-git-staged 至少其一');
  process.exit(2);
}

const { injectRules } = await import(pathToFileURL(libRules).href);
const result = injectRules({ paths: changed, touches, budgetChars: budget });

if (format === 'json') {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  if (!result.root) {
    console.error('[inject-rules] 未找到 rules/ 目录（AUTOTEST_RULES_DIR 可显式指定）');
    process.exit(1);
  }
  if (result.matched.length === 0) {
    console.error(`[inject-rules] 无命中规则（paths=${changed.length} touches=${touches.length}）`);
    process.exit(1);
  }
  process.stdout.write(`# 规则注入（${result.matched.length} 条命中，预算 ${result.budgetChars} 字符，实注入 ${result.totalChars}）\n\n`);
  process.stdout.write(`${result.text}\n`);
  const summary = result.matched.map((m) => `${m.id}[${m.injected}]`).join(' ');
  process.stderr.write(`[inject-rules] 命中：${summary}${result.truncated.length ? `；摘要注入：${result.truncated.join(',')}` : ''}${result.dropped.length ? `；丢弃：${result.dropped.join(',')}` : ''}\n`);
}
