// 静态资源服务：把前端产物挂在 HTTP 服务器的一个前缀下。
// 纯 node:http handler，带路径穿越防护与 MIME 映射；找不到文件返回 404。
//
// 两种用法：
//  - DSH 插件（默认参数）：prefix='/autotest-web'，无 SPA、无预压缩（与历史行为一致）；
//  - 独立服务器（standalone.ts）：prefix='' + spa + gzip + immutable，
//    服务 build:standalone 产物（dist/web，同目录附带 .gz 预压缩文件）。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
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

/** 可预压缩的文本类型（.gz 伴生文件只对这些类型生成）。 */
const TEXT_MIME = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map']);

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
export function makeStaticHandler(webDir: string, opts: StaticOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(webDir);
  const prefix = opts.prefix ?? '/autotest-web';
  const spa = opts.spa ?? false;
  const gzip = opts.gzip ?? false;
  const immutable = opts.immutable ?? false;

  const sendText = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  };

  /** 按 Accept-Encoding 选实际要发的文件（有 .gz 伴生且客户端接受 gzip 时优先）。 */
  const pickFile = (file: string, req: IncomingMessage): { file: string; encoding?: string } => {
    if (!gzip) return { file };
    if (!TEXT_MIME.has(extname(file).toLowerCase())) return { file };
    if (!String(req.headers['accept-encoding'] ?? '').toLowerCase().includes('gzip')) return { file };
    const gz = `${file}.gz`;
    if (existsSync(gz) && statSync(gz).isFile()) return { file: gz, encoding: 'gzip' };
    return { file };
  };

  const serve = (res: ServerResponse, file: string, encoding: string | undefined, rel: string, head: boolean): void => {
    // MIME 必须按**去掉 .gz 后缀后**的真实文件名推导：
    // extname('index.html.gz') = '.gz'，若直接 replace 掉会得到空串 → MIME 查不到 →
    // 回落 application/octet-stream → 浏览器把主页当文件下载（真实事故：主框架导航
    // isDownload=true 直接白屏）。先剥 .gz 再取扩展名才对。
    const realName = file.endsWith('.gz') ? file.slice(0, -3) : file;
    const type = MIME[extname(realName).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': type };
    if (encoding) {
      headers['Content-Encoding'] = encoding;
      headers.Vary = 'Accept-Encoding';
    }
    if (immutable) {
      // index.html 必须每次校验（它引用 hashed 资产名）；/assets/* 带内容哈希，可永久缓存。
      // 注意用 '/' 而非 path.sep：URL 路径分隔符恒为 '/'，Windows 上 sep='\' 会让判断永远落空。
      headers['Cache-Control'] = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    try {
      headers['Content-Length'] = String(statSync(file).size);
      res.writeHead(200, headers);
      if (head) { res.end(); return; }
      createReadStream(file).pipe(res);
    } catch {
      sendText(res, 500, 'Internal Server Error');
    }
  };

  return (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
      }
      const head = method === 'HEAD';
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (prefix && pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/';
      if (pathname.includes('..')) {
        sendText(res, 400, 'Bad Request');
        return;
      }
      let rel = pathname.replace(/^\/+/, '');
      if (rel === '') rel = 'index.html';
      const file = resolve(root, rel);
      if (file !== root && !file.startsWith(root + sep)) {
        sendText(res, 400, 'Bad Request');
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        // SPA 回退：hash 路由之外的路径一律落到 index.html
        if (spa) {
          const indexFile = join(root, 'index.html');
          if (existsSync(indexFile)) {
            const picked = pickFile(indexFile, req);
            serve(res, picked.file, picked.encoding, 'index.html', head);
            return;
          }
        }
        sendText(res, 404, 'Not Found');
        return;
      }
      const picked = pickFile(file, req);
      serve(res, picked.file, picked.encoding, rel, head);
    } catch {
      sendText(res, 500, 'Internal Server Error');
    }
  };
}
