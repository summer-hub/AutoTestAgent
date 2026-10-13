// 规格导出入口（esbuild 第三产物 dist/specs.mjs）：
// 让自检脚本（纯 JS，无 TS loader）能导入命令规格与注册表助手——
// 消费方：scripts/verify-agent-tools.mjs（漂移检测 + 双端到端）。
export { COMMANDS } from './commands/index.js';
export { allCommands, getCommand, groups, toInputSchema, toToolDescription, roleSatisfies, pathParams } from './core/registry.js';
