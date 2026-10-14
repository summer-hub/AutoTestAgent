import { type FailureKind } from './contract.js';
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
export declare function classifyFailure(input: ClassifyInput): Classification;
/** 退出码归一化：把子进程真实退出码映射到平台的四个语义码。 */
export declare function normalizeExitCode(raw: number | null, timedOut: boolean, cancelled: boolean): number;
/** 供前端/知识库检索用的失败分类中文名。 */
export declare const FAILURE_LABEL: Record<FailureKind, string>;
/** 校验一个字符串是否是合法 FailureKind（供 API 入参与 preset 校验用）。 */
export declare function isFailureKind(s: string): s is FailureKind;
