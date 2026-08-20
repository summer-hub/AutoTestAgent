// 静态资源服务：把嵌入版前端（lib/web）挂在 ctx.webServer 的 /autotest-web 前缀下。
// 纯 node:http handler，带路径穿越防护与 MIME 映射；找不到文件返回 404。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};
const ROUTE_PREFIX = '/autotest-web';
/** 构造静态 handler；webDir 必须是插件内置 web 目录的绝对路径。 */
export function makeStaticHandler(webDir) {
    const root = resolve(webDir);
    return (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            let pathname = decodeURIComponent(url.pathname);
            if (pathname.startsWith(ROUTE_PREFIX))
                pathname = pathname.slice(ROUTE_PREFIX.length) || '/';
            if (pathname.includes('..')) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Bad Request');
                return;
            }
            let rel = pathname.replace(/^\/+/, '');
            if (rel === '')
                rel = 'index.html';
            const file = resolve(root, rel);
            if (file !== root && !file.startsWith(root + sep)) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Bad Request');
                return;
            }
            if (!existsSync(file) || !statSync(file).isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }
            const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
            createReadStream(file).pipe(res);
        }
        catch {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error');
        }
    };
}
