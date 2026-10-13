// 规则注入（B3-2）：把 rules/ 的开发纪律按「触碰的路径 / 主题」注入编码 agent 的
// 上下文——从「CI 事后 FAIL」升级为「编码时眼前就有」。
//
// 与 octospec 对齐的语义：
//   - 命中 = 变更路径 glob 命中 inject_when.paths **或** 触碰主题命中 inject_when.touches（并集）；
//   - 排序 = load_bearing 优先，然后 priority 降序；
//   - 预算 = budgetChars 内注入规则全文；放不下时退化为摘要行（title+description）；
//     连摘要都放不下的丢弃（记入 dropped）。
//
// 消费方：
//   - GET /rules/inject 路由（agent-tools 的 CLI / MCP 经此调用，远程 agent 可用）；
//   - scripts/inject-rules.mjs（本地开发工作流：git hook / 编辑器 / 终端）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuleMeta {
  id: string;
  title: string;
  description: string;
  tags: string[];
  priority: number;
  loadBearing: boolean;
  paths: string[];
  touches: string[];
}

export interface RuleFull extends RuleMeta {
  /** frontmatter 之后的正文（markdown） */
  body: string;
  file: string;
}

export interface InjectRequest {
  /** 变更文件路径（相对 autotest/ 或仓库根，内部归一化） */
  paths?: string[];
  /** 触碰主题标签（如 transaction / secrets） */
  touches?: string[];
  /** 注入预算（字符），默认 8000，钳制 [500, 50000] */
  budgetChars?: number;
}

export interface InjectHit {
  id: string;
  title: string;
  priority: number;
  loadBearing: boolean;
  injected: 'full' | 'summary';
  chars: number;
}

export interface InjectResult {
  /** rules 目录绝对路径；未部署为 null */
  root: string | null;
  budgetChars: number;
  matched: InjectHit[];
  /** 只注入了摘要（预算放不下全文）的规则 id */
  truncated: string[];
  /** 连摘要都放不下被丢弃的规则 id */
  dropped: string[];
  totalChars: number;
  /** 可直接喂给编码 agent 的 markdown 文本 */
  text: string;
}

/** rules 目录解析（覆盖部署形态）：AUTOTEST_RULES_DIR > 包内（桌面端 staged）> 仓库开发布局。 */
export function rulesRoot(): string | null {
  const env = String(process.env.AUTOTEST_RULES_DIR ?? '').trim();
  if (env && existsSync(env)) return resolve(env);
  // 本文件位于 <包根>/lib/services/ → 包根是 ../..
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const candidates = [
    pkgRoot + '/rules',     // 桌面端 staged（resources/server/rules/）
    pkgRoot + '/../rules',  // 仓库开发 / 独立版（dsh-autotest → autotest/rules）
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

/** 解析 frontmatter + 正文。非规则文件（无 id）返回 null。 */
function parseRuleFile(file: string): RuleFull | null {
  const txt = readFileSync(file, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const field = (key: string): string => {
    const km = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return km ? km[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const id = field('id');
  if (!id) return null;
  const inlineArray = (key: string): string[] => {
    const km = fm.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
    if (!km) return [];
    return [...km[1].matchAll(/"([^"]*)"|'([^']*)'|([^,\s]+)/g)].map((x) => x[1] ?? x[2] ?? x[3]).filter(Boolean);
  };
  const blockArray = (key: string): string[] => {
    const km = fm.match(new RegExp(`^\\s*${key}:\\s*\\n((?:\\s+-[^\n]*\n?)+)`, 'm'));
    if (!km) return [];
    return [...km[1].matchAll(/-\s*["']?([^"'\n]+?)["']?\s*(?:#.*)?$/gm)].map((x) => x[1].trim()).filter(Boolean);
  };
  const arr = (key: string): string[] => { const a = inlineArray(key); return a.length ? a : blockArray(key); };
  return {
    id,
    title: field('title'),
    description: field('description'),
    tags: arr('tags'),
    priority: Number(field('priority')) || 0,
    loadBearing: field('load_bearing') === 'true',
    paths: arr('paths'),
    touches: arr('touches'),
    body: m[2] ?? '',
    file,
  };
}

/** 加载全部规则（按 load_bearing→priority 降序，与索引口径一致）。 */
export function loadRules(): RuleFull[] {
  const root = rulesRoot();
  if (!root) return [];
  const out: RuleFull[] = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    if (!statSync(full).isFile() || !name.endsWith('.md') || name.startsWith('_')) continue;
    const r = parseRuleFile(full);
    if (r) out.push(r);
  }
  return out.sort((a, b) => Number(b.loadBearing) - Number(a.loadBearing) || b.priority - a.priority);
}

/** glob → RegExp：`**` 跨目录、`*` 不跨目录；其余字符原样。 */
function globToRe(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

/** 路径归一化：统一正斜杠；剥掉仓库根前缀，使规则里的 paths  glob 可命中。 */
function normalizePath(p: string): string {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  // 传入可能是仓库根相对（autotest/...）或 autotest 内相对（dsh-autotest/...）——两种都试
  return s;
}

function pathMatches(rulePath: string, changed: string): boolean {
  if (globToRe(rulePath).test(changed)) return true;
  // 兼容仓库根相对的输入：剥掉前导 autotest/ 再试
  const stripped = changed.replace(/^autotest\//, '');
  return stripped !== changed && globToRe(rulePath).test(stripped);
}

/** 按请求注入规则。 */
export function injectRules(req: InjectRequest): InjectResult {
  const root = rulesRoot();
  const budget = Math.max(500, Math.min(50_000, Math.trunc(req.budgetChars ?? 8000)));
  const result: InjectResult = { root, budgetChars: budget, matched: [], truncated: [], dropped: [], totalChars: 0, text: '' };
  if (!root) return result;

  const paths = (req.paths ?? []).map(normalizePath).filter(Boolean);
  const touches = new Set((req.touches ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean));
  const rules = loadRules();

  const hits = rules.filter((r) =>
    paths.some((p) => r.paths.some((g) => pathMatches(g, p)))
    || [...touches].some((t) => r.touches.some((rt) => rt.toLowerCase() === t)),
  );

  const blocks: string[] = [];
  let used = 0;
  for (const r of hits) {
    const body = r.body.trim();
    const fullBlock = `## [${r.id}] ${r.title}\n\n${body}\n`;
    const summaryBlock = `## [${r.id}] ${r.title}\n\n${r.description}\n`;
    let block: string;
    let kind: 'full' | 'summary';
    if (used + fullBlock.length <= budget) {
      block = fullBlock;
      kind = 'full';
    } else if (used + summaryBlock.length <= budget) {
      block = summaryBlock;
      kind = 'summary';
      result.truncated.push(r.id);
    } else {
      result.dropped.push(r.id);
      continue;
    }
    blocks.push(block);
    used += block.length;
    result.matched.push({ id: r.id, title: r.title, priority: r.priority, loadBearing: r.loadBearing, injected: kind, chars: block.length });
  }
  result.totalChars = used;
  result.text = blocks.join('\n');
  return result;
}
