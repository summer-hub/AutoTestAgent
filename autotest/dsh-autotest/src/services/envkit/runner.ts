// envkit 执行器：真正把脚本跑起来，并把结果归一成平台认识的结构。
//
// 一句话职责：给定契约 + 参数，在受控超时与可取消的前提下执行脚本入口，
// 采集声明的产物（路径 + 大小 + sha256），把退出码归一化，把失败归类。
//
// 关键设计（都是踩过坑才这么定的）：
//  1. **跨平台入口选择**：Windows 用 .ps1、POSIX 用 .sh。选择发生在 runner，
//     契约里只写一个不带后缀的相对路径——否则同一份契约要为两个 OS 各写一遍。
//  2. **超时与取消分离**：超时是"跑太久"，取消是"人喊停"。两者都不是脚本的错，
//     所以退出码与失败分类都必须区分开（见 failure.ts 的优先级）。
//  3. **产物必须真存在**：脚本说产出了 hap，runner 要真的 stat 到才算。
//     "构建成功但找不到产物"是最骗人的失败，必须单独归一类。
//  4. **日志落盘**：stderr/stdout 全量写文件，不只在内存里——几十分钟的构建，
//     内存缓冲会丢，而且事后归因需要原文。
//  5. **绝不 shell=True 拼字符串**：参数按数组传递，避免注入（与 gitRepo/hdc 同纪律）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, type ScriptContract } from './contract.js';
import { classifyFailure, normalizeExitCode } from './failure.js';

/** 脚本资产的根目录（随包分发；构建时由 scripts/build-assets.mjs 复制进 lib/assets/env/）。 */
export function envScriptsRoot(): string {
  // 本文件位于 <包根>/lib/services/envkit（或 src/services/envkit）
  // Windows 坑（rules/windows-nodejs-pitfalls）：必须用 fileURLToPath，
  // 不能用 `new URL(import.meta.url).pathname`——后者在 Windows 上返回 "/D:/..."
  // （前导斜杠），拼出来的路径会变成 "D:\D:\code\..."（盘符翻倍），实测踩过。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, '../../..');
  const candidates = [
    path.join(pkgRoot, 'lib', 'assets', 'env'),   // 构建后
    path.join(pkgRoot, 'assets', 'env'),          // tsx 直接跑 src/
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

/** 按 OS 选入口文件：契约 entry 不含后缀，这里补 .ps1 / .sh。 */
export function resolveEntry(contract: ScriptContract): { file: string; exists: boolean; shell: string[] } {
  const root = envScriptsRoot();
  const base = path.join(root, contract.entry);
  if (process.platform === 'win32') {
    const file = `${base}.ps1`;
    return { file, exists: fs.existsSync(file), shell: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] };
  }
  const file = `${base}.sh`;
  return { file, exists: fs.existsSync(file), shell: ['bash'] };
}

export interface RunStepInput {
  contract: ScriptContract;
  /** 已按契约解析并填充默认值的参数 */
  params: Record<string, unknown>;
  /** 工作目录（通常是库的仓库目录） */
  cwd: string;
  /** 取消信号（任务 lane / 批次取消时触发） */
  signal?: AbortSignal;
  /** 日志目录（不存在则创建）；不传则不落盘（自检里用） */
  logDir?: string;
  /** 超时毫秒（缺省用契约的 timeout_sec） */
  timeoutMs?: number;
}

export interface ArtifactInfo {
  name: string;
  path: string;
  exists: boolean;
  size: number;
  sha256: string;
}

export interface RunStepResult {
  ok: boolean;
  exitCode: number;
  failureKind: string;
  failureWhat: string;
  matched?: string;
  inTaxonomy: boolean;
  durationMs: number;
  artifacts: ArtifactInfo[];
  /**
   * 脚本声明的**标量输出**（从 stdout 的 `KEY=value` 行解析）。
   * 这是步骤间串联的桥梁：build_hap 输出 HAP_PATH=/x/y.hap，
   * 后续 hdc_install 的 hapPath 参数就能写 {{hapPath}} 引用它。
   * 键已归一成小驼峰（HAP_PATH → hapPath），与契约的入参名对齐。
   */
  outputs: Record<string, string>;
  logPath: string;
  /** 输出末尾若干行（给人快速看，不必开日志文件） */
  tail: string[];
  /** 参数回显（审计用：跑的时候到底传了什么） */
  command: string;
}

/**
 * 把参数按契约顺序转成命令行 argv（数组传递，不经 shell 拼接）。
 *
 * ⚠️ 跨平台参数前缀是**实测踩过的坑**：Windows PowerShell 5.1 只认 `-paramName`
 * （单横杠、大小写不敏感），**不认** `--param-name`；而 bash 只认 `--param-name`。
 * 统一发 `--kebab-case` 会让所有 .ps1 脚本参数绑定失败、以退出码 1 结束，
 * 进而被误归类成"业务失败但未归类"——根因在错误信息里看不出来。
 * 所以这里按入口类型分流：ps1 用 `-name`，sh 用 `--kebab-name`。
 */
export function buildArgv(contract: ScriptContract, params: Record<string, unknown>, opts: { powershell?: boolean } = {}): string[] {
  const argv: string[] = [];
  const ps = opts.powershell === true;
  const flag = (name: string): string => (ps ? `-${name}` : `--${kebab(name)}`);
  for (const p of contract.inputs) {
    const v = params[p.name];
    if (v === undefined || v === null || v === '') continue;
    if (p.type === 'boolean') {
      if (v === true) argv.push(flag(p.name));
      continue;
    }
    argv.push(flag(p.name), String(v));
  }
  return argv;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * 从脚本输出里解析 `KEY=value` 行（步骤间串联的桥梁）。
 *
 * 约定（各 env 脚本统一遵守）：关键产物用 `UPPER_SNAKE=值` 的形式打到 stdout，
 * 例如 build_hap 打 `HAP_PATH=/x/y.hap`、build_manifest 打 `BUNDLE_NAME=com.x`。
 * 这里把它们归一成小驼峰（HAP_PATH → hapPath），与契约入参名对齐，
 * 后续步骤的参数就能写 `{{hapPath}}` 引用。
 *
 * 只认"整行都是 KEY=value"的行，避免把日志里的 `error=xxx` 也当输出。
 */
export function parseScalarOutputs(tail: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of tail) {
    const m = /^([A-Z][A-Z0-9_]{2,})=(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    const val = m[2].trim();
    if (val) out[key] = val;
  }
  return out;
}

function sha256File(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/** 执行单个脚本步骤。永不抛异常——失败也是结果（带 failureKind）。 */
export async function runScriptStep(input: RunStepInput): Promise<RunStepResult> {
  const { contract, params, cwd, signal } = input;
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? contract.timeout_sec * 1000;
  const { file, exists, shell } = resolveEntry(contract);
  const argv = [...shell, file, ...buildArgv(contract, params, { powershell: process.platform === 'win32' })];

  if (!exists) {
    return {
      ok: false, exitCode: EXIT_CODES.ENV_MISSING, failureKind: 'toolchain_missing',
      failureWhat: `脚本入口不存在：${file}`, inTaxonomy: contract.failure_taxonomy.includes('toolchain_missing'),
      durationMs: 0, outputs: {}, artifacts: [], logPath: '', tail: [], command: argv.join(' '),
    };
  }
  if (signal?.aborted) {
    return {
      ok: false, exitCode: EXIT_CODES.CANCELLED, failureKind: 'cancelled', failureWhat: '开始前已取消',
      inTaxonomy: contract.failure_taxonomy.includes('cancelled'), durationMs: 0,
      outputs: {}, artifacts: [], logPath: '', tail: [], command: argv.join(' '),
    };
  }

  let logPath = '';
  let logStream: fs.WriteStream | null = null;
  if (input.logDir) {
    try {
      fs.mkdirSync(input.logDir, { recursive: true });
      logPath = path.join(input.logDir, `${contract.id}.log`);
      logStream = fs.createWriteStream(logPath, { flags: 'w' });
    } catch { /* 日志落盘失败不影响执行本身 */ }
  }

  const tail: string[] = [];
  const pushTail = (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
      logStream?.write(`${line}\n`);
    }
  };

  const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    let timedOut = false;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, timedOut });
    };

    const child = spawn(argv[0], argv.slice(1), {
      cwd, shell: false, windowsHide: true,
      env: { ...process.env, AUTOTEST_ENVKIT: '1' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // 宽限 3 秒等进程真死，再收尾；否则 duration 与日志都是半截
      setTimeout(() => done(null), 3000);
    }, timeoutMs);

    const onAbort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (b: Buffer) => pushTail(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => pushTail(b.toString('utf8')));
    child.on('error', (e: Error) => {
      // spawn 失败 = 命令不存在（ENOENT），归一成工具缺失
      pushTail(`[envkit] spawn 失败：${e.message}`);
      done(e.message.includes('ENOENT') ? EXIT_CODES.ENV_MISSING : EXIT_CODES.BIZ_FAILED);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { done(EXIT_CODES.CANCELLED); return; }
      done(code);
    });
  });

  logStream?.end();

  const cancelled = signal?.aborted === true;
  const exitCode = normalizeExitCode(result.code, result.timedOut, cancelled);
  const cls = classifyFailure({
    exitCode, output: tail.join('\n'), timedOut: result.timedOut, cancelled,
    taxonomy: contract.failure_taxonomy,
  });

  // 产物采集：契约声明了几个 output，就真的去 stat 几个。
  //
  // 产物的路径可以从两处来（这是端到端自检暴露出来的缺口）：
  //   ① 入参里给了路径（如 hdc_install 的 hapPath 由上游步骤填充）；
  //   ② 脚本自己打印的 KEY=value（如 build_hap 打 HAP_PATH=...、ohpm_install 打 OH_MODULES_PATH=...）。
  // 只查入参会漏掉第 ② 类——那些脚本自己算出的产物路径，于是"产物是否存在"永远校验不到，
  // artifact_not_found 这条最重要的判据形同虚设。所以两侧合并后再 stat。
  const scalarOutputs = parseScalarOutputs(tail);
  const artifacts: ArtifactInfo[] = [];
  for (const o of contract.outputs) {
    const fromParam = params[o.name];
    const fromOutput = scalarOutputs[o.name];
    const raw = fromParam !== undefined && fromParam !== null && fromParam !== ''
      ? fromParam
      : fromOutput;
    const p = raw ? path.resolve(cwd, String(raw)) : '';
    const exists = !!p && fs.existsSync(p);
    artifacts.push({
      name: o.name, path: p, exists,
      size: exists ? fs.statSync(p).size : 0,
      sha256: exists && fs.statSync(p).isFile() ? sha256File(p) : '',
    });
  }

  // 产物缺失要能盖过"退出码 0"：构建说成功但没有 hap，这是失败不是成功。
  // ⚠️ 判据必须是契约声明的**类型**（type=path），不是名字后缀 _path：
  // 契约用的是小驼峰（hapPath/ohModulesPath），写下划线后缀永远匹配不上，
  // 整条校验会静默失效（实测踩过：声明了产物却从不校验）。
  const missingArtifacts = artifacts.filter((a, i) => contract.outputs[i]?.type === 'path' && !a.exists);
  const ok = exitCode === EXIT_CODES.OK && missingArtifacts.length === 0;

  return {
    ok, exitCode,
    failureKind: ok ? '' : (missingArtifacts.length > 0 && (exitCode === EXIT_CODES.OK || cls.kind === 'unknown')
      ? 'artifact_not_found'
      : cls.kind),
    failureWhat: ok ? '' : (missingArtifacts.length > 0 && (exitCode === EXIT_CODES.OK || cls.kind === 'unknown')
      ? `声明产物未生成：${missingArtifacts.map((a) => a.name).join(', ')}`
      : cls.what),
    matched: cls.matched,
    inTaxonomy: cls.inTaxonomy,
    durationMs: Date.now() - startedAt,
    outputs: scalarOutputs,
    artifacts, logPath, tail: tail.slice(-20), command: argv.join(' '),
  };
}
