// 规则索引生成器（B3-1）：扫 rules/*.md 的 frontmatter，生成 _index.yaml
// （mirror frontmatter——工具无需解析每个文件即可解析注入）。
// 与 skills-lock 同模式：--check 模式供 CI 门禁（索引与实际不一致 exit 1）。
//
// 用法（autotest/ 下执行）：
//   node scripts/gen-rules-index.mjs           # 生成
//   node scripts/gen-rules-index.mjs --check   # 只校验（CI 用）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesDir = join(root, 'rules');
const indexFile = join(rulesDir, '_index.yaml');
const CHECK_MODE = process.argv.includes('--check');

if (!existsSync(rulesDir)) {
  console.error(`[rules-index] rules 目录不存在：${rulesDir}`);
  process.exit(1);
}

/** 解析 frontmatter（--- 包裹的 YAML 块）。返回 null 表示不是规则文件。 */
function parseRule(file) {
  const txt = readFileSync(file, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = m[1];
  const field = (key) => {
    const km = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return km ? km[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const id = field('id');
  if (!id) return null;
  // inject_when.paths / touches：行内数组（["a", "b"]）或块列表
  const inlineArray = (key) => {
    const km = fm.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
    if (!km) return [];
    return [...km[1].matchAll(/"([^"]*)"|'([^']*)'|([^,\s]+)/g)].map((x) => x[1] ?? x[2] ?? x[3]).filter(Boolean);
  };
  const blockArray = (key) => {
    const km = fm.match(new RegExp(`^\\s*${key}:\\s*\\n((?:\\s+-[^\\n]*\\n?)+)`, 'm'));
    if (!km) return [];
    return [...km[1].matchAll(/-\s*["']?([^"'\n]+?)["']?\s*(?:#.*)?$/gm)].map((x) => x[1].trim()).filter(Boolean);
  };
  const arr = (key) => { const a = inlineArray(key); return a.length ? a : blockArray(key); };
  const num = field('priority');
  return {
    id,
    title: field('title'),
    description: field('description'),
    tags: arr('tags'),
    priority: Number(num) || 0,
    load_bearing: field('load_bearing') === 'true',
    inject_when: { paths: arr('paths'), touches: arr('touches') },
  };
}

const rules = [];
for (const name of readdirSync(rulesDir).sort()) {
  const full = join(rulesDir, name);
  if (!statSync(full).isFile() || !name.endsWith('.md') || name.startsWith('_')) continue;
  const r = parseRule(full);
  if (!r) { console.warn(`[rules-index] 跳过（无有效 frontmatter）：${name}`); continue; }
  rules.push(r);
}

if (rules.length === 0) {
  console.error('[rules-index] 没有任何规则');
  process.exit(1);
}

// 冲突检测（id 唯一性）
const seen = new Set();
for (const r of rules) {
  if (seen.has(r.id)) { console.error(`[rules-index] 重复 id：${r.id}`); process.exit(1); }
  seen.add(r.id);
  if (!r.inject_when.paths.length && !r.inject_when.touches.length) {
    console.error(`[rules-index] ${r.id} 缺少 inject_when（paths/touches 至少其一）`);
    process.exit(1);
  }
}

// 生成索引（mirror frontmatter，按 load_bearing→priority 排序，与注入器口径一致）
const sorted = [...rules].sort((a, b) => Number(b.load_bearing) - Number(a.load_bearing) || b.priority - a.priority);
const lines = [
  '# 规则索引（gen-rules-index.mjs 生成，勿手改）',
  '# 解析语义（与 octospec 对齐）：',
  '#   - id 全局唯一；load_bearing 规则在预算内优先注入全文；',
  '#   - inject_when = paths glob 或 touches tag（并集），命中一次即注入；',
  '#   - 超预算：保留 load_bearing，然后 priority 降序，未纳入的只注入 summary 行。',
  'rules:',
];
for (const r of sorted) {
  lines.push(`  - id: ${r.id}`);
  lines.push(`    title: ${JSON.stringify(r.title)}`);
  lines.push(`    description: ${JSON.stringify(r.description)}`);
  lines.push(`    priority: ${r.priority}`);
  lines.push(`    load_bearing: ${r.load_bearing}`);
  lines.push(`    tags: [${r.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  lines.push('    inject_when:');
  lines.push(`      paths: [${r.inject_when.paths.map((p) => JSON.stringify(p)).join(', ')}]`);
  lines.push(`      touches: [${r.inject_when.touches.map((t) => JSON.stringify(t)).join(', ')}]`);
}
const out = `${lines.join('\n')}\n`;

if (CHECK_MODE) {
  if (!existsSync(indexFile)) {
    console.error('[rules-index] ❌ 索引不存在（请先 node scripts/gen-rules-index.mjs）');
    process.exit(1);
  }
  const cur = readFileSync(indexFile, 'utf8');
  if (cur !== out) {
    console.error('[rules-index] ❌ 索引与 rules/ 实际不一致——规则增删改后必须重新生成并提交');
    process.exit(1);
  }
  console.log(`[rules-index] ✅ 索引与 ${rules.length} 条规则一致`);
  process.exit(0);
}

writeFileSync(indexFile, out);
console.log(`[rules-index] 已生成 ${indexFile}（${rules.length} 条规则）`);
for (const r of sorted) {
  console.log(`  ${r.id}  priority=${r.priority}${r.load_bearing ? ' load_bearing' : ''}  paths=${r.inject_when.paths.length} touches=${r.inject_when.touches.length}`);
}
