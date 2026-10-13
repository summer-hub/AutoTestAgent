export interface RuleMeta {
    id: string;
    title: string;
    description: string;
    tags: string[];
    priority: number;
    loadBearing: boolean;
    paths: string[];
    touches: string[];
}
export interface RuleFull extends RuleMeta {
    /** frontmatter 之后的正文（markdown） */
    body: string;
    file: string;
}
export interface InjectRequest {
    /** 变更文件路径（相对 autotest/ 或仓库根，内部归一化） */
    paths?: string[];
    /** 触碰主题标签（如 transaction / secrets） */
    touches?: string[];
    /** 注入预算（字符），默认 8000，钳制 [500, 50000] */
    budgetChars?: number;
}
export interface InjectHit {
    id: string;
    title: string;
    priority: number;
    loadBearing: boolean;
    injected: 'full' | 'summary';
    chars: number;
}
export interface InjectResult {
    /** rules 目录绝对路径；未部署为 null */
    root: string | null;
    budgetChars: number;
    matched: InjectHit[];
    /** 只注入了摘要（预算放不下全文）的规则 id */
    truncated: string[];
    /** 连摘要都放不下被丢弃的规则 id */
    dropped: string[];
    totalChars: number;
    /** 可直接喂给编码 agent 的 markdown 文本 */
    text: string;
}
/** rules 目录解析（覆盖部署形态）：AUTOTEST_RULES_DIR > 包内（桌面端 staged）> 仓库开发布局。 */
export declare function rulesRoot(): string | null;
/** 加载全部规则（按 load_bearing→priority 降序，与索引口径一致）。 */
export declare function loadRules(): RuleFull[];
/** 按请求注入规则。 */
export declare function injectRules(req: InjectRequest): InjectResult;
