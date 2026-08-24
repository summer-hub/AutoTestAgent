import { IncomingMessage } from 'node:http';
import { AuthUser } from './service.js';
export interface HandlerArgs {
    params: Record<string, string>;
    query: URLSearchParams;
    body: any;
    auth?: AuthUser;
    req: IncomingMessage;
}
export type RouteFn = (method: string, pattern: string, handler: (args: HandlerArgs) => Promise<unknown>, opts?: {
    permission?: string;
}) => void;
/** 从请求头解析 Bearer token。 */
export declare function bearerToken(req: IncomingMessage): string;
/** 认证中间件：返回当前用户，无 token / 无效抛 401。 */
export declare function requireAuth(req: IncomingMessage): Promise<AuthUser>;
/** 注册 /auth/* 路由（http.ts 的 route 函数传入）。 */
export declare function registerAuthRoutes(route: RouteFn): void;
