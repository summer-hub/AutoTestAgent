import type { IncomingMessage, ServerResponse } from 'node:http';
export interface StaticOptions {
    /** 挂载前缀；默认 '/autotest-web'（DSH 插件现状）。独立版传 '' 表示站点根。 */
    prefix?: string;
    /** 单页应用回退：文件不存在时回 index.html（hash 路由深链接需要）。默认 false。 */
    spa?: boolean;
    /** 服务构建期生成的 .gz 伴生文件（Accept-Encoding: gzip 时）。默认 false。 */
    gzip?: boolean;
    /** hashed 资产（/assets/*）长缓存 + index.html no-cache。默认 false。 */
    immutable?: boolean;
}
/** 构造静态 handler；webDir 必须是前端产物目录的绝对路径。 */
export declare function makeStaticHandler(webDir: string, opts?: StaticOptions): (req: IncomingMessage, res: ServerResponse) => void;
