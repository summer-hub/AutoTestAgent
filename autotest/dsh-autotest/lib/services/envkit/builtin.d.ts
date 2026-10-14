import type { ScriptContract } from './contract.js';
export declare const BUILTIN_SCRIPTS: ScriptContract[];
/** 按 id 取内置契约。 */
export declare function builtinScript(id: string): ScriptContract | undefined;
/** 内置脚本 id 清单（供自检与 agent-tools 规格引用）。 */
export declare const BUILTIN_SCRIPT_IDS: string[];
