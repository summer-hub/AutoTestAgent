/** 设计 §6.6 的 7 种 oracle 取值域。 */
export type OracleType = 'control_text' | 'text_value' | 'hilog_keyword' | 'state_flag' | 'no_crash' | 'screenshot_diff' | 'script_assert';
export declare const ORACLE_LABEL: Record<OracleType, string>;
export interface Oracle {
    type: OracleType;
    /** 目标控件文本（control_text / text_value / state_flag 必填） */
    control?: string;
    /** control_text：期望出现还是消失 */
    expect?: 'appear' | 'disappear';
    /** text_value：比较方式 */
    op?: 'equals' | 'contains' | 'matches';
    /** text_value / hilog_keyword 的期望值 */
    value?: string;
    keyword?: string;
    /** no_crash / hilog_keyword 关注的日志级别 */
    level?: 'E' | 'W' | 'I';
    /** state_flag：期望的 checkable 值 */
    state?: boolean;
    /** screenshot_diff 的允许差异比例（0-1） */
    threshold?: number;
    /** script_assert 的断言表达式（必须非平凡） */
    expr?: string;
    /** 判据说明（人读；不参与校验） */
    note?: string;
}
export interface OracleProblem {
    index: number;
    reason: string;
}
/**
 * 校验一组 oracle 是否**真的可机器校验**。
 * 返回空数组表示通过 —— 这是"允许入库"的唯一依据。
 */
export declare function validateOracles(oracles: unknown): OracleProblem[];
/** 用例是否达到"可机器校验"的入库门槛。 */
export declare function hasVerifiableOracle(oracles: unknown): boolean;
export interface ExecutionFacts {
    passed: boolean;
    /** 实际执行的步骤（真机句式） */
    steps: string[];
    /** 执行器记录的每步结果 */
    stepResults?: Array<{
        desc: string;
        status: 'passed' | 'failed' | 'skipped';
    }>;
    /** 执行期间是否校验了 oracle（由执行器在断言步骤上打点） */
    oraclesChecked?: number;
}
export interface FalsePassVerdict {
    falsePass: boolean;
    severity: 'none' | 'weak' | 'false';
    reason: string;
}
/**
 * 是否是"验证步骤"。
 *
 * 必须按**句式开头**判断，不能在整句里找"验证"两个字：
 * 真机 demo 里按钮就叫「验证」（json-schema 的每个页面都有一个），
 * 于是 `点击「验证」` 会被误认为验证步骤 —— 那样任何点了这个按钮的用例
 * 都会"看起来有断言"，正是我们要防的假通过。
 */
export declare function isVerifyStep(step: string): boolean;
/**
 * 反假通过（修 R12）。
 *
 * 判据只有一条主线：**"通过"必须有可核对的依据**。
 *   - 通过了但一条 oracle 都没有 → 假通过（最严重：把没测变成测过）；
 *   - 通过了但一个 oracle 都没被实际校验（oraclesChecked=0）→ 假通过；
 *   - 通过了但步骤里没有任何验证动作 → 弱通过（说明用例本身没设计断言）。
 * 失败（未通过）的用例不属于假通过 —— 它至少暴露了问题。
 */
export declare function detectFalsePass(oracles: unknown, exec: ExecutionFacts): FalsePassVerdict;
export interface QualityReport {
    libraryId: number;
    total: number;
    /** 带可机器校验 oracle 的用例数 */
    withOracle: number;
    /** 断言覆盖率（硬门槛 100%） */
    oracleCoverage: number;
    /** 通过但断言为空/未校验的用例（硬门槛 0） */
    falsePass: number;
    falsePassCases: Array<{
        caseNo: string;
        name: string;
        reason: string;
    }>;
    missingOracleCases: Array<{
        caseNo: string;
        name: string;
        reason: string;
    }>;
    /** 两个硬门槛是否达标 */
    gates: {
        oracleCoverage: boolean;
        falsePass: boolean;
        allPassed: boolean;
    };
}
/** 计算某库的质量指标并判定硬门槛（数据来自库里已落地的用例）。 */
export declare function evaluateQuality(libraryId: number): Promise<QualityReport>;
/** 把 oracle 写入用例（生成/优化阶段落库）。 */
export declare function saveCaseOracles(caseId: number, oracles: Oracle[]): Promise<void>;
