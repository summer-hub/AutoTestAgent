export type ScopeKind = 'library' | 'api' | 'control' | 'scenario' | 'global';
export type KnowledgeKind = 'traversal_quirk' | 'oracle_recipe' | 'special_handling' | 'blocked_reason' | 'demo_patch' | 'human_verdict';
export type KnowledgeStatus = 'ai_draft' | 'human_confirmed' | 'rejected' | 'deprecated';
export declare const SCOPE_LABEL: Record<ScopeKind, string>;
export declare const KIND_LABEL: Record<KnowledgeKind, string>;
export declare const STATUS_LABEL: Record<KnowledgeStatus, string>;
export interface KnowledgeEntry {
    id: string;
    scopeKind: ScopeKind;
    scopeKey: string;
    kind: KnowledgeKind;
    title: string;
    keywords: string[];
    status: KnowledgeStatus;
    confidence: number;
    evidence: Array<Record<string, unknown>>;
    /** 正文四段：现象 / 原因 / 处置 / 结论 */
    body: string;
    createdAt: string;
    updatedAt: string;
    /** 相对 workspace/knowledge/wiki 的路径（落盘位置） */
    wikiPath: string;
}
/** 生成 slug（文件名安全、可读）。 */
export declare function slugify(title: string): string;
/** 渲染成 markdown（front-matter + 正文）。 */
export declare function renderEntry(e: KnowledgeEntry): string;
/**
 * 解析 markdown → 条目。**解析失败返回 null 而不是抛错**：
 * 知识目录里可能有半成品/手写笔记，一条坏文件不该让整个知识库读不出来。
 */
export declare function parseEntry(md: string): Omit<KnowledgeEntry, 'wikiPath'> | null;
/** 内容哈希（md 是否变化；也为将来切片入向量库预留，设计 §7.7）。 */
export declare function contentHash(text: string): string;
export interface RetrieveQuery {
    library?: string;
    apiName?: string;
    controlFingerprint?: string;
    scenarioKind?: string;
    stage?: string;
    /** 预算（字符数）：按 score 截断 */
    budgetChars?: number;
}
/** 关键词分词：中文按字/词混合、英文按单词；去停用词与单字噪声。 */
export declare function tokenize(text: string): string[];
/**
 * 三级检索（设计 §7.4）：
 *   ① 结构化命中：scope_kind + scope_key 精确匹配
 *   ② 关键词命中：命中 keywords 的条目按命中数排序
 *   ③ 排序截断：score = 3*scope精确 + 2*关键词命中数 + (human_confirmed ? 2 : 0) + confidence/100
 *      保证至少注入 1 条 library 级 + 1 条 scenario 级（若有），再按 score 取到预算为止
 *
 * 已否决/已过时的条目不参与（rejected/deprecated）。
 */
export declare function retrieve(query: RetrieveQuery, entries: KnowledgeEntry[], budgetChars?: number): {
    selected: KnowledgeEntry[];
    scored: Array<{
        entry: KnowledgeEntry;
        score: number;
        why: string;
    }>;
    truncated: number;
};
/** 注入格式（设计 §7.4-4）：标题 + 现象 + 处置 + 结论，不含 front-matter，标注来源与置信度。 */
export declare function renderInjection(selected: KnowledgeEntry[]): string;
export declare function wikiRoot(): string;
/** 条目落盘目录（按 scope 分层，设计 §7.3）。 */
export declare function entryDir(e: Pick<KnowledgeEntry, 'scopeKind' | 'scopeKey'>): string;
/** 扫描 md → 条目数组（**md 是唯一事实来源**）。坏文件会被跳过并计数，不影响其余。 */
export declare function loadEntriesFromDisk(): {
    entries: KnowledgeEntry[];
    broken: string[];
};
/** 写一条条目（md + 重建索引 + 刷新 DB 索引）。 */
export declare function saveEntry(e: Omit<KnowledgeEntry, 'wikiPath' | 'updatedAt'> & {
    updatedAt?: string;
}): Promise<KnowledgeEntry>;
/** 由 md 重建 index.json 与 DB 索引表。 */
export declare function rebuildIndex(): Promise<{
    total: number;
    broken: string[];
}>;
/**
 * 人工确认（生命周期 §7.6）：**没有 evidence 的条目不允许确认** ——
 * 知识条目的价值来自"这事真发生过"，没有证据的结论就是传闻。
 */
export declare function canConfirm(e: KnowledgeEntry): {
    ok: boolean;
    reason: string;
};
/** 接口签名变化 → api 级条目自动降级为 deprecated（设计 §7.6）。 */
export declare function deprecateStaleApiEntries(libraryId: number): Promise<{
    checked: number;
    deprecated: string[];
}>;
/**
 * 从人工队列的结论沉淀知识条目（设计 §6.7：「结论一律沉淀为知识条目」）。
 * stage → kind 的映射是刻意的：队列里人解决的是哪类问题，决定这条知识属于哪一类。
 */
export declare function kindForStage(stage: string): KnowledgeKind;
export declare function sediteFromQueue(item: {
    libraryId: number;
    libraryName: string;
    caseNo: string;
    stage: string;
    reason: string;
    question: string;
    resolution: string;
    payload: Record<string, unknown>;
}): Promise<KnowledgeEntry>;
/** 为某个阶段检索并渲染注入文本（各阶段按 §7.5 的预算与 kinds 取用）。 */
export declare function injectForStage(stage: string, query: RetrieveQuery): {
    text: string;
    picked: Array<{
        title: string;
        why: string;
    }>;
    truncated: number;
};
