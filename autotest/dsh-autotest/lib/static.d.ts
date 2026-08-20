import type { IncomingMessage, ServerResponse } from 'node:http';
/** 构造静态 handler；webDir 必须是插件内置 web 目录的绝对路径。 */
export declare function makeStaticHandler(webDir: string): (req: IncomingMessage, res: ServerResponse) => void;
