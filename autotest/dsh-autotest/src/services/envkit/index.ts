// envkit 统一出口：环境纵轴（脚本资产 + 环境画像 + 运行编排）。
//
// 分层（与 rules/arch-layering 一致：db → services → api）：
//   contract.ts  纯函数：契约形状、校验、参数解析、指纹
//   failure.ts   纯函数：失败分类码表、退出码归一化
//   runner.ts    IO：真正 spawn 脚本，采集产物，落日志
//   builtin.ts   数据：内置脚本契约（R1 首批 5 个）
//   scripts.ts   DB：内置 + DB 覆盖的注册表、播种、漂移检测
//   envProfile.ts 编排：一次环境准备的生命周期（建 run→逐 step→缓存→取消）
//
// api 层只应 import 本文件，不要直接钻到某个子模块——否则换实现要改一堆调用点。
export {
  FAILURE_KINDS, EXIT_CODES, TOOLCHAIN_BINS,
  validateContract, resolveParams, contractFingerprint,
  type FailureKind, type ScriptContract, type ParamSpec, type ContractProblem,
} from './contract.js';

export { classifyFailure, normalizeExitCode, FAILURE_LABEL, isFailureKind } from './failure.js';

export { runScriptStep, buildArgv, resolveEntry, envScriptsRoot } from './runner.js';
export type { RunStepInput, RunStepResult, ArtifactInfo } from './runner.js';

export { BUILTIN_SCRIPTS, BUILTIN_SCRIPT_IDS, builtinScript } from './builtin.js';

export {
  listScripts, getScript, seedBuiltinScripts, validateAllScripts, detectContractDrift,
} from './scripts.js';
export type { ScriptRow, ScriptValidationReport } from './scripts.js';

export {
  runEnvProfile, loadProfileSteps, fingerprintOf,
} from './envProfile.js';
export type { EnvProfile, ProfileStep, StepOutcome, RunProfileResult, RunProfileOptions } from './envProfile.js';
