export type TestabilityClass = 'A' | 'B' | 'C' | 'D';
export declare const CLASS_LABEL: Record<TestabilityClass, string>;
export interface PatchEdit {
    file: string;
    line: number;
    before: string;
    after: string;
    note: string;
}
export interface PatchDraft {
    class: TestabilityClass;
    target: string;
    reason: string;
    edits: PatchEdit[];
    impact?: string[];
    revert: string;
    verify: string[];
    risk: string;
}
export interface CaseFacts {
    caseId: number;
    caseNo: string;
    name: string;
    scenarioKind: string;
    /** 用例步骤（真机句式） */
    steps: string[];
    expected: string;
}
export interface SymbolFacts {
    id: number;
    name: string;
    kind: string;
    signature: string;
    params: Array<{
        name: string;
        type: string;
        optional: boolean;
        defaultValue: string;
        doc: string;
    }>;
    returns: {
        type: string;
        doc: string;
    };
    throws: Array<{
        type: string;
        doc: string;
    }>;
    methods: string[];
}
export interface DemoFacts {
    /** demo（src/main）里的真实调用点 */
    demoCalls: Array<{
        pagePath: string;
        sourceFile: string;
        sourceLine: number;
        snippet: string;
    }>;
    /** 真机遍历到的、该页面的可交互控件文本 */
    deviceControls: string[];
    /** 该页面上可注入的数据点（@State 等字面量） */
    paramPoints: Array<{
        pagePath: string;
        name: string;
        sourceFile: string;
        sourceLine: number;
    }>;
    /** 单元测试调用数（仅作参考，不构成真机可测） */
    testCallCount: number;
}
export interface Verdict {
    class: TestabilityClass;
    reason: string;
    /** 判定依据的逐条证据（可核对） */
    evidence: string[];
    /** 用例需要构造的输入（喂给补丁生成与脚本生成） */
    requiredInputs: string[];
    /** 触发入口（页面 + 控件） */
    triggerPage: string;
    triggerControl: string;
}
/**
 * 是否为 D 类（无法测）。
 * 这是**唯一允许"拒测"的出口**，所以判定必须有明确信号词并写出来源，
 * 否则就成了"不想测就判 D"的后门。
 */
export declare function detectUntestable(c: CaseFacts, sym: SymbolFacts): {
    isD: boolean;
    reasons: string[];
};
/** 从场景维度推出"这条用例需要构造什么输入"，用于判断 demo 现有入口能否满足。 */
export declare function requiredInputsOf(c: CaseFacts, sym: SymbolFacts): string[];
/**
 * 从用例步骤里抽出被引用的控件文本（真机句式：点击「X」/输入「X」到「Y」/验证「X」）。
 * 这是"这条用例在真机上点得到吗"的唯一直接依据。
 */
export declare function referencedControls(steps: string[]): string[];
export declare function classifyCase(c: CaseFacts, sym: SymbolFacts | null, demo: DemoFacts): Verdict;
/** 场景 → 把现有字面量改成什么值（B 类补丁的核心）。 */
export declare function scenarioValueFor(scenario: string, current: string): {
    value: string;
    note: string;
};
/**
 * 从一行开始，取出**完整的模板字面量**（可能跨行）。
 * 真机 demo 的数据点普遍是 `@State message: string = \`多行样例代码\``，
 * 只认单行等于放弃了这一整类数据点（实测这个库 100% 的数据点都是多行）。
 */
export declare function extractTemplateLiteral(source: string, lineNo: number): {
    text: string;
    startLine: number;
} | null;
/**
 * 生成补丁草案。
 *
 * B 类：定位页面上的数据点，把它替换成该场景需要的取值（支持**多行模板字面量**）。
 * C 类：在页面 build() 的控件后追加一个调用按钮（最小侵入，只新增不修改既有逻辑）。
 * 找不到安全锚点时**不生成补丁**，而是把位置与理由写进 reason —— 硬凑一个改不对的补丁
 * 比不生成更坏。
 */
export declare function draftPatch(c: CaseFacts, sym: SymbolFacts, demo: DemoFacts, verdict: Verdict, readFile: (rel: string) => string | null): PatchDraft;
export interface ApplyResult {
    ok: boolean;
    copyDir: string;
    applied: PatchEdit[];
    failed: Array<{
        edit: PatchEdit;
        reason: string;
    }>;
    manifestFile: string;
}
/** 判断目标路径是否在副本目录内（防目录穿越；补丁绝不能写到副本之外）。 */
export declare function isInside(copyRoot: string, rel: string): boolean;
/**
 * 把补丁应用到**独立副本**。
 *
 * 关键纪律：
 *   ① 目标文件必须在副本目录内（越界一律拒绝）；
 *   ② 每处编辑的 `before` 必须在副本里**恰好出现一次**：0 次说明源码已变、多次说明位置不唯一，
 *      两种都拒绝 —— 代码变了还硬替换，等于悄悄改坏了别人的工程；
 *   ③ 写入 manifest（原始内容），保证可精确回退。
 *
 * 用「唯一子串替换」而不是按行号替换：真机 demo 的数据点普遍是多行模板字面量
 * （`@State code: string = \`多行样例\``），按行号根本替换不了这一整类。
 */
export declare function applyPatchToCopy(copyRoot: string, patch: PatchDraft): ApplyResult;
/** 回退：把副本里的改动逐处还原（原仓库自始至终未被改动）。 */
export declare function revertCopy(copyRoot: string): {
    ok: boolean;
    removed: string[];
};
/** 独立副本根目录（设计 §6.5 指定：workspace/demo-patches/<lib>/<caseNo>/）。 */
export declare function patchDirFor(libName: string, caseNo: string): string;
/** 复制 demo 到独立副本（排除构建产物与依赖目录；原仓库只读）。 */
export declare function makeCopy(srcDir: string, destDir: string): {
    ok: boolean;
    files: number;
    reason?: string;
};
export interface TestabilityRunResult {
    libraryId: number;
    libraryName: string;
    total: number;
    byClass: Record<TestabilityClass, number>;
    /** 需要人介入的：D 类（人工队列）与 C 类（要改代码） */
    humanQueue: Array<{
        caseNo: string;
        name: string;
        class: TestabilityClass;
        reason: string;
    }>;
    withPatch: number;
    details: Array<{
        caseId: number;
        caseNo: string;
        class: TestabilityClass;
        reason: string;
        hasPatch: boolean;
    }>;
}
/**
 * 为一个库的全部用例做可测性判定并落库。
 *
 * "100% 用例带 A/B/C/D 判定"是设计验收项，所以这里**不跳过任何用例**：
 * 关联了接口符号的按符号+场景判，没关联的按"步骤引用的控件在真机上是否存在"判，
 * 两者都拿不到依据的也给出 C 并写明"需要人工确认入口"，绝不留空。
 */
export declare function runTestability(libraryId: number): Promise<TestabilityRunResult>;
/** 批准并应用补丁：先把 demo 复制成独立副本，再在副本上应用。**原仓库只读。** */
export declare function applyCasePatch(caseId: number): Promise<{
    ok: boolean;
    copyDir: string;
    files: number;
    applied: PatchEdit[];
    failed: Array<{
        edit: PatchEdit;
        reason: string;
    }>;
    reason?: string;
}>;
/** 回退：还原副本里的改动（并可选删除副本目录）。 */
export declare function revertCasePatch(caseId: number, removeCopy?: boolean): Promise<{
    ok: boolean;
    removed: string[];
    copyDir: string;
}>;
