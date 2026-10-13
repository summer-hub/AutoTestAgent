// AutoTest agent CLI（octo-cli 模式）——给 AI Agent Bot 通过 exec 调用的薄客户端。
//
// 契约（与 docs 的退出码表一致）：
//   成功 → stdout 单个 JSON envelope；失败 → stderr 错误 envelope + 确定性退出码；零交互。
// 用法：cli.mjs <command> [位置参数] [--flag value] [--token x] [--base url] [--pretty] [--confirm] [--out f]
//      cli.mjs --help [命令]     帮助树 / 命令参数详情（也可用 help 伪命令）
//      cli.mjs --version         打印版本
import { allCommands, buildRequest, getCommand, groups, pathParams, type CommandSpec } from './core/registry.js';
import { apiRequest, resolveClient } from './core/client.js';
import { ApiError, emitErr, emitOk, exitCodeFor, EXIT, LocalValidationError } from './core/envelope.js';
import { renderCommandHelp, renderHelpTree } from './core/help.js';
import { VERSION } from './core/meta.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Parsed {
  command: string;
  flags: Record<string, string>;
  positionals: string[];
  opts: { token?: string; base?: string; pretty: boolean; confirm: boolean; out?: string; help: boolean; version: boolean };
}

function parseArgv(argv: string[]): Parsed {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  let token: string | undefined;
  let base: string | undefined;
  let out: string | undefined;
  let pretty = false;
  let confirm = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') { pretty = true; continue; }
    if (a === '--confirm') { confirm = true; continue; }
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--version' || a === '-v') { version = true; continue; }
    if (a === '--token') { token = argv[++i]; continue; }
    if (a.startsWith('--token=')) { token = a.slice(8); continue; }
    if (a === '--base') { base = argv[++i]; continue; }
    if (a.startsWith('--base=')) { base = a.slice(7); continue; }
    if (a === '--out') { out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out = a.slice(6); continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      // 负数字（-5）也是值：只把 -- 开头当 flag
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; }
      else flags[k] = 'true';
      continue;
    }
    positionals.push(a);
  }
  return { command: positionals[0] ?? '', flags, positionals: positionals.slice(1), opts: { token, base, pretty, confirm, out, help, version } };
}

/** 位置参数按序填入：路径参数优先，其后是规格里声明 positional 的参数。 */
function bindPositionals(spec: CommandSpec, positionals: string[], flags: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...flags };
  const slots = [...pathParams(spec), ...spec.params.filter((p) => p.positional).map((p) => p.name)];
  positionals.forEach((v, i) => { if (slots[i]) args[slots[i]] = v; });
  return args;
}

/** help 输出：目标命令存在 → 命令详情；否则全量树。未知目标按错误处理。 */
function showHelp(target: string, pretty: boolean): void {
  if (target) {
    const spec = getCommand(target);
    if (!spec) {
      emitErr(target, { code: 'UNKNOWN_COMMAND', message: `未知命令：${target}`, hint: `可用命令：${allCommands().map((c) => c.name).join(', ')}` });
      process.exit(EXIT.LOCAL_VALIDATION);
    }
    process.stdout.write(`${renderCommandHelp(spec)}\n`);
  } else {
    process.stdout.write(`${renderHelpTree()}\n`);
  }
  process.exit(EXIT.OK);
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const { command } = parsed;

  if (parsed.opts.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT.OK);
  }

  // help：--help [命令] 或 help [命令] 伪命令
  const isHelp = parsed.opts.help || command === 'help';
  if (isHelp) {
    showHelp(command === 'help' ? (parsed.positionals[0] ?? '') : command, parsed.opts.pretty);
    return;
  }

  // 未指定命令：帮助树到 stderr + 退出码 2（用法错误，但给出可发现性）
  if (!command) {
    process.stderr.write(`${renderHelpTree()}\n`);
    process.exit(EXIT.LOCAL_VALIDATION);
  }

  const spec = getCommand(command);
  if (!spec) {
    emitErr(command, {
      code: 'UNKNOWN_COMMAND',
      message: `未知命令：${command}`,
      hint: `可用命令组：${groups().map((g) => g.group).join(', ')}；全部命令：${allCommands().map((c) => c.name).join(', ')}`,
    });
    process.exit(EXIT.LOCAL_VALIDATION);
  }

  // 危险操作本地前置确认：未带 --confirm 不发请求（与服务端审批流是两道独立闸门）
  if (spec.dangerous && !parsed.opts.confirm) {
    emitErr(command, {
      code: 'LOCAL_VALIDATION',
      message: `危险操作需 --confirm 显式确认：${spec.method} ${spec.path}`,
      hint: '确认影响面后带 --confirm 重试；审批模式下服务端还会要求人工批准',
    });
    process.exit(EXIT.LOCAL_VALIDATION);
  }

  const args = bindPositionals(spec, parsed.positionals, parsed.flags);
  try {
    const req = buildRequest(spec, args);
    const client = resolveClient({ base: parsed.opts.base, token: parsed.opts.token });
    const res = await apiRequest(client, req);
    // 二进制导出（xlsx）：落盘到 --out（或服务端建议的文件名），envelope 汇报文件信息
    if (res.binary) {
      const buf = res.data as unknown as Buffer;
      const outPath = resolve(parsed.opts.out ?? res.filename ?? `autotest-export-${Date.now()}.xlsx`);
      writeFileSync(outPath, buf);
      emitOk(command, { file: outPath, bytes: buf.length, filename: res.filename ?? null }, { url: res.url, durationMs: res.durationMs }, { pretty: parsed.opts.pretty });
      process.exit(EXIT.OK);
    }
    emitOk(command, res.data, { url: res.url, durationMs: res.durationMs }, { pretty: parsed.opts.pretty });
    process.exit(EXIT.OK);
  } catch (e) {
    if (e instanceof LocalValidationError) {
      emitErr(command, { code: 'LOCAL_VALIDATION', message: e.message });
      process.exit(EXIT.LOCAL_VALIDATION);
    }
    if (e instanceof ApiError) {
      const noToken = !parsed.opts.token && !process.env.AUTOTEST_TOKEN;
      emitErr(command, {
        code: e.code,
        message: e.message,
        statusCode: e.statusCode || undefined,
        hint: e.hint ?? (e.code === 'UNAUTHORIZED' && noToken
          ? '未配置令牌：--token 或环境变量 AUTOTEST_TOKEN（服务端「系统配置 → API Key 与访问控制」创建）'
          : undefined),
      });
      process.exit(exitCodeFor(e));
    }
    emitErr(command, { code: 'LOCAL_VALIDATION', message: (e as Error).message });
    process.exit(EXIT.LOCAL_VALIDATION);
  }
}

void main();
