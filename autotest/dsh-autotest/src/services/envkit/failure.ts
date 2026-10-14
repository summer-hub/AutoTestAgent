// envkit 失败分类层：把"脚本退出码 + stderr"归成有限个 FailureKind。
//
// 为什么需要它：脚本报错的形式千奇百怪（退出码 1、stderr 里一句 npm ERR、
// 一句"command not found"），如果直接把原始错误给人看，人每次都要重新判断
// "这到底是网络问题还是工具没装"。归类成有限集合后：
//   · 前端可以按类别聚合（"这 12 个库都卡在 toolchain_missing"）；
//   · 知识库可以按类别召回（同类失败上次是怎么修的）；
//   · 人工队列可以按「类别 × 阻塞原因」批量解决，而不是一次解决一个库。
//
// 纯函数区（无 IO）：由 verify-envkit 离线覆盖。
import { EXIT_CODES, FAILURE_KINDS, type FailureKind } from './contract.js';

/** stderr/stdout 的失败信号 → 失败分类。顺序即优先级（先匹配到的赢）。 */
const SIGNALS: Array<{ re: RegExp; kind: FailureKind; what: string }> = [
  // 工具缺失必须在最前：否则"deveco-cli: command not found"会被后面的编译错误规则吃掉
  { re: /(command not found|is not recognized as an internal or external command|no such file or directory.*(?:hvigorw|ohpm|hdc|deveco)|'ohpm' 不是内部或外部命令|不是内部或外部命令)/i, kind: 'toolchain_missing', what: '工具链命令不存在' },
  { re: /(?:deveco-cli|devecocli|hvigorw|ohpm|hdc)\s*(?:version)?\s*(?:未安装|not installed|not found)/i, kind: 'toolchain_missing', what: '工具链未安装' },
  // 网络
  { re: /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|network|超时|timeout.*(?:connect|fetch|download)|could not resolve host|proxy)/i, kind: 'network', what: '网络/代理问题' },
  // 权限
  { re: /(EACCES|EPERM|permission denied|拒绝访问|需要管理员|requires elevation|access is denied)/i, kind: 'permission', what: '权限不足' },
  // 设备
  { re: /(device offline|no devices\/emulators found|device unauthorized|hdc:.*(?:not found|offline)|设备离线|未授权)/i, kind: 'device_offline', what: '设备离线或未授权' },
  // 版本冲突
  { re: /(version (?:conflict|mismatch)|incompatible|不兼容|api level|sdk.*version|版本不匹配|expected version)/i, kind: 'sdk_version_conflict', what: '工具链/SDK 版本不匹配' },
  // 缺依赖（二进制/子模块/配置文件）
  { re: /(submodule|子模块|missing (?:dependency|dependencies|module|binary)|找不到.*(?:\.so|\.a|依赖)|no such module|cannot find module|未找到依赖)/i, kind: 'missing_dep', what: '缺二进制依赖/子模块/模块' },
  // 编译错误
  { re: /(compile ?error|compilation failed|ERROR:.*\.(?:ets|ts|js)|构建失败|build failed|hvigor.*error)/i, kind: 'compile_error', what: '编译失败' },
  // 产物缺失（构建"成功"但没有产物——最容易骗过人的一类）
  { re: /(artifact (?:not found|missing)|no (?:hap|har|hsp) (?:file )?(?:found|generated)|产物.*(?:不存在|未生成))/i, kind: 'artifact_not_found', what: '预期产物未生成' },
];

export interface ClassifyInput {
  exitCode: number;
  /** stderr + stdout 合并后的文本（信号匹配用） */
  output: string;
  /** 步骤是否因超时被杀 */
  timedOut?: boolean;
  /** 步骤是否因取消而中断 */
  cancelled?: boolean;
  /** 契约声明的失败分类（归类结果必须在其中，否则说明码表漏了） */
  taxonomy: readonly FailureKind[];
}

export interface Classification {
  kind: FailureKind;
  /** 一句话说明（给人看） */
  what: string;
  /** 命中的信号原文（便于核对"为什么归成这类"） */
  matched?: string;
  /** 归类结果是否落在契约声明的分类表内（false = 契约该扩了） */
  inTaxonomy: boolean;
}

/**
 * 归类。优先级：取消 > 超时 > 退出码 > 信号文本。
 *
 * 取消与超时优先于是因为它们不是"脚本的错"：把取消归成 compile_error
 * 会让人去查一个根本不存在的编译问题。
 */
export function classifyFailure(input: ClassifyInput): Classification {
  if (input.cancelled) return finish('cancelled', '任务已取消', input.taxonomy);
  if (input.timedOut || input.exitCode === EXIT_CODES.TIMEOUT) return finish('timeout', '步骤超时', input.taxonomy);

  // 环境缺失：退出码 2 优先于信号（脚本可能没来得及打印"command not found"）
  if (input.exitCode === EXIT_CODES.ENV_MISSING) return finish('toolchain_missing', '工具链命令缺失（退出码 2）', input.taxonomy);

  const text = String(input.output ?? '');
  for (const sig of SIGNALS) {
    const m = sig.re.exec(text);
    if (m) return finish(sig.kind, sig.what, input.taxonomy, m[0].slice(0, 120));
  }

  // 退出码 1 但没有任何信号命中：业务失败，但归不到具体类别
  if (input.exitCode === EXIT_CODES.BIZ_FAILED) return finish('unknown', '业务失败但未归类（请扩充失败分类码表）', input.taxonomy);
  return finish('unknown', `未归类失败（退出码 ${input.exitCode}）`, input.taxonomy);
}

function finish(kind: FailureKind, what: string, taxonomy: readonly FailureKind[], matched?: string): Classification {
  return { kind, what, matched, inTaxonomy: taxonomy.includes(kind) };
}

/** 退出码归一化：把子进程真实退出码映射到平台的四个语义码。 */
export function normalizeExitCode(raw: number | null, timedOut: boolean, cancelled: boolean): number {
  if (cancelled) return EXIT_CODES.CANCELLED;
  if (timedOut) return EXIT_CODES.TIMEOUT;
  if (raw === null || raw === undefined) return EXIT_CODES.ENV_MISSING; // 没退出码 = 没起来（多半是命令不存在）
  return raw;
}

/** 供前端/知识库检索用的失败分类中文名。 */
export const FAILURE_LABEL: Record<FailureKind, string> = {
  network: '网络/代理',
  permission: '权限不足',
  toolchain_missing: '工具链缺失',
  sdk_version_conflict: '版本不匹配',
  compile_error: '编译失败',
  missing_dep: '缺依赖/子模块',
  device_offline: '设备离线',
  artifact_not_found: '产物未生成',
  timeout: '超时',
  cancelled: '已取消',
  unknown: '未归类',
};

/** 校验一个字符串是否是合法 FailureKind（供 API 入参与 preset 校验用）。 */
export function isFailureKind(s: string): s is FailureKind {
  return (FAILURE_KINDS as readonly string[]).includes(s);
}
