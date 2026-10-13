// 帮助文本渲染：从 registry 自动生成——help 树是命令规格的第三个消费方
// （CLI 执行 / MCP tools/list / help 文本），三者的单一事实源都是 commands/index.ts。
//
// 输出到 stdout（--help 是成功操作，exit 0）；纯文本、无 ANSI 依赖（agent 捕获也友好）。
import { allCommands, groups, pathParams, type CommandSpec } from './registry.js';
import { EXIT_TABLE } from './envelope.js';

const GLOBAL_OPTS = [
  ['--token <key>', 'API Key（也可用环境变量 AUTOTEST_TOKEN）'],
  ['--base <url>', 'API 基地址（默认 http://127.0.0.1:3280/api/autotest；也可用 AUTOTEST_BASE_URL）'],
  ['--pretty', '缩进输出 JSON envelope'],
  ['--confirm', '危险操作（删除类）显式确认；审批模式下服务端还会二次拦截'],
  ['--out <path>', '二进制导出（cases.export）落盘路径'],
  ['--help [命令]', '帮助；带命令名看该命令参数详情'],
  ['--version', '打印版本'],
] as const;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** 全量帮助：用法 + 全局选项 + 命令组树 + 退出码表。 */
export function renderHelpTree(): string {
  const lines: string[] = [];
  lines.push('AutoTest agent CLI — 给 AI Agent Bot 通过 exec 调用的薄客户端');
  lines.push('');
  lines.push('用法：cli.mjs <command> [位置参数] [--flag value] [全局选项]');
  lines.push('');
  lines.push('全局选项：');
  for (const [flag, desc] of GLOBAL_OPTS) lines.push(`  ${pad(flag, 16)}${desc}`);
  lines.push('');
  lines.push('命令组：');
  for (const g of groups()) {
    lines.push(`  ${g.group}`);
    for (const c of g.commands) {
      const tags = [c.role, c.dangerous ? 'dangerous' : ''].filter(Boolean).join(' · ');
      lines.push(`    ${pad(c.name, 24)}${c.summary}${tags ? `  [${tags}]` : ''}`);
    }
  }
  lines.push('');
  lines.push(`共 ${allCommands().length} 条命令；详情：cli.mjs --help <command> 或 cli.mjs help <command>`);
  lines.push('');
  lines.push('退出码：');
  for (const e of EXIT_TABLE) lines.push(`  ${e.code}  ${pad(e.name, 18)}${e.when}`);
  return lines.join('\n');
}

/** 单命令详情：方法/路径/角色/危险标记/参数表/示例。 */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  const tags = [`role:${spec.role}`, spec.dangerous ? 'dangerous（需 --confirm）' : '', spec.binary ? 'binary（--out 落盘）' : ''].filter(Boolean).join(' · ');
  lines.push(`${spec.name} — ${spec.summary}`);
  lines.push(`  ${spec.method} ${spec.path}${tags ? `   [${tags}]` : ''}`);
  const pathPs = pathParams(spec);
  const slots = [...pathPs, ...spec.params.filter((p) => p.positional).map((p) => p.name)];
  if (slots.length > 0) {
    lines.push('  位置参数：');
    slots.forEach((s, i) => lines.push(`    #${i + 1} ${s}`));
  }
  if (spec.params.length > 0) {
    lines.push('  参数：');
    for (const p of spec.params) {
      const attrs = [
        p.required ? '必填' : '可选',
        p.type,
        p.positional ? '位置参数' : `--${p.flag ?? p.name}`,
        p.enum ? `枚举: ${p.enum.join('|')}` : '',
        p.default !== undefined ? `默认: ${String(p.default)}` : '',
      ].filter(Boolean).join(' · ');
      lines.push(`    ${pad(`--${p.flag ?? p.name}`, 22)}${pad(attrs, 46)}${p.description}`);
    }
  } else {
    lines.push('  参数：（无）');
  }
  // 示例：位置参数用占位值，flag 参数用 --k <v>
  const exParts: string[] = [spec.name];
  for (const s of slots) exParts.push(`<${s}>`);
  for (const p of spec.params.filter((x) => !x.positional && x.required)) exParts.push(`--${p.flag ?? p.name} <${p.name}>`);
  lines.push('');
  lines.push(`  示例：cli.mjs ${exParts.join(' ')}`);
  return lines.join('\n');
}
