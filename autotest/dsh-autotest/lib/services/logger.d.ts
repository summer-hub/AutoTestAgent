export declare const logger: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
    /** 请求日志（仅 json 模式输出；文本模式不打，避免日志泛滥） */
    request: (method: string, route: string, status: number, durationMs: number, extra?: Record<string, unknown>) => void;
};
export declare function jsonLogEnabled(): boolean;
