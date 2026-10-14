// envkit 内置脚本资产（R1 首批）：ohpm_install / build_manifest / build_har / build_hap / hdc_install。
//
// 定位：这是「从克隆代码到装上包」这条链头的**最小可用集**。每一步都遵循同一套纪律：
//   · 契约先行（inputs/outputs/failure_taxonomy/idempotent/timeout/approval 七项齐全）；
//   · 幂等可重入（二次执行走增量，不重复全量编译）；
//   · 产物必须真存在（runner 会 stat，缺产物即失败，见 runner.ts 的 artifact_not_found）；
//   · 失败必须可归类（归不进去 = 码表该扩，见 failure.ts）。
//
// 脚本本体在 assets/env/<entry>.{ps1,sh}，由 scripts/build-assets.mjs 随包复制到 lib/assets/env/。
// 这里只放**契约**（数据），不放实现——契约是单一事实源，实现可按需换语言。
//
// 为什么用 .ps1/.sh 而不是直接 Node spawn：这些命令本身就是工具链 CLI
// （ohpm/hvigorw/hdc），包一层脚本是为了「参数组装 + 产物定位 + 日志规范」三件事可统一替换，
// 平台侧永远只认契约，不认某个脚本的实现细节。
import type { ScriptContract } from './contract.js';

/** 鸿蒙库的通用构建参数（har/hap 都需要）。 */
const PROJECT_DIR = {
  name: 'projectDir', type: 'path' as const, required: true,
  description: '库工程根目录（含 build-profile.json5 的那一层）',
};
const MODULE = { name: 'module', type: 'string' as const, default: 'entry', description: '模块名（HAP 侧通常是 entry）' };

export const BUILTIN_SCRIPTS: ScriptContract[] = [
  {
    id: 'ohpm_install',
    summary: '安装 ohpm 依赖（oh_modules），含 oh-package.json5 依赖解析',
    entry: 'ohpm-install',
    version: '1.0.0',
    inputs: [
      PROJECT_DIR,
      { name: 'ohpmRegistry', type: 'string', description: 'ohpm 源地址（留空用工程/全局配置）' },
      { name: 'offline', type: 'boolean', default: false, description: '离线模式（只用本地缓存）' },
    ],
    outputs: [{ name: 'ohModulesPath', type: 'path', description: 'oh_modules 目录（安装成功的判据）' }],
    applies_when: { library_kind: ['animation', 'network', 'storage', 'ui_component', 'codec', 'unknown'] },
    failure_taxonomy: ['network', 'permission', 'toolchain_missing', 'sdk_version_conflict', 'missing_dep', 'timeout'],
    idempotent: true,
    timeout_sec: 1800,
    approval: 'none',
  },
  {
    id: 'build_manifest',
    summary: '读取并校验工程清单（build-profile.json5 / oh-package.json5），产出构建事实',
    entry: 'build-manifest',
    version: '1.0.0',
    inputs: [PROJECT_DIR],
    outputs: [
      { name: 'manifestPath', type: 'path', description: '归一化后的 manifest JSON（runner 采集）' },
      { name: 'bundleName', type: 'string', description: '应用包名（供真机遍历与执行用）' },
    ],
    applies_when: { library_kind: ['animation', 'network', 'storage', 'ui_component', 'codec', 'unknown'] },
    failure_taxonomy: ['missing_dep', 'compile_error', 'unknown', 'timeout'],
    idempotent: true,
    timeout_sec: 300,
    approval: 'none',
  },
  {
    id: 'build_har',
    summary: '构建 HAR 包（三方库的交付形态，供宿主应用集成）',
    entry: 'build-har',
    version: '1.0.0',
    inputs: [
      PROJECT_DIR,
      MODULE,
      { name: 'buildMode', type: 'enum', values: ['debug', 'release'], default: 'debug', description: '构建模式' },
      { name: 'product', type: 'string', default: 'default', description: 'product 名（对应 build-profile.json5 的 products）' },
    ],
    outputs: [
      { name: 'harPath', type: 'path', description: '产出的 .har 文件（必须真实存在）' },
      { name: 'buildId', type: 'string', description: '本次构建标识（用于缓存键与追溯）' },
    ],
    applies_when: { library_kind: ['animation', 'network', 'storage', 'ui_component', 'codec', 'unknown'] },
    failure_taxonomy: ['compile_error', 'missing_dep', 'sdk_version_conflict', 'toolchain_missing', 'artifact_not_found', 'permission', 'timeout'],
    idempotent: true,
    timeout_sec: 3600,
    approval: 'operator',
  },
  {
    id: 'build_hap',
    summary: '构建 HAP 包（含 library 模块的宿主工程，真机安装的单位）',
    entry: 'build-hap',
    version: '1.0.0',
    inputs: [
      PROJECT_DIR,
      MODULE,
      { name: 'buildMode', type: 'enum', values: ['debug', 'release'], default: 'debug', description: '构建模式' },
      { name: 'product', type: 'string', default: 'default', description: 'product 名' },
    ],
    outputs: [
      { name: 'hapPath', type: 'path', description: '产出的 .hap 文件（必须真实存在）' },
      { name: 'buildId', type: 'string', description: '本次构建标识' },
    ],
    applies_when: { library_kind: ['animation', 'network', 'storage', 'ui_component', 'codec', 'unknown'] },
    failure_taxonomy: ['compile_error', 'missing_dep', 'sdk_version_conflict', 'toolchain_missing', 'artifact_not_found', 'permission', 'timeout'],
    idempotent: true,
    timeout_sec: 3600,
    approval: 'operator',
  },
  {
    id: 'hdc_install',
    summary: '安装 HAP 到真机（hdc install），安装前校验设备在线',
    entry: 'hdc-install',
    version: '1.0.0',
    inputs: [
      { name: 'hapPath', type: 'path', required: true, description: '待安装的 .hap 文件' },
      { name: 'deviceSerial', type: 'string', description: '设备序列号（留空用 hdc list targets 的第一个）' },
      { name: 'replace', type: 'boolean', default: true, description: '覆盖安装（-r）' },
    ],
    outputs: [{ name: 'installLog', type: 'string', description: 'hdc install 的输出（成功判据含 "Successfully install"）' }],
    applies_when: { os: ['windows', 'linux', 'darwin'], library_kind: ['animation', 'network', 'storage', 'ui_component', 'codec', 'unknown'] },
    failure_taxonomy: ['device_offline', 'toolchain_missing', 'permission', 'artifact_not_found', 'sdk_version_conflict', 'unknown', 'timeout'],
    idempotent: true,
    timeout_sec: 900,
    approval: 'operator',
  },
];

/** 按 id 取内置契约。 */
export function builtinScript(id: string): ScriptContract | undefined {
  return BUILTIN_SCRIPTS.find((s) => s.id === id);
}

/** 内置脚本 id 清单（供自检与 agent-tools 规格引用）。 */
export const BUILTIN_SCRIPT_IDS = BUILTIN_SCRIPTS.map((s) => s.id);
