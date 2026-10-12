// 零依赖 CDP（Chrome DevTools Protocol）客户端 —— Node 24 原生 WebSocket 实现。
// 用途：在没有 computer_use_tool / aha_browser_use 的环境里，用真实 Chrome 做 UI 全量测试。
// 安全纪律（沿用 browser-use-automation skill）：只读测试，不碰 cookie/凭据，不提交有副作用的表单。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动 headless Chrome（隔离 profile），返回 { kill }。 */
export async function launchChrome(port = 9222) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch { /* 未就绪，重试 */ }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      throw new Error(`Chrome DevTools 端口 ${port} 20s 内未就绪`);
    }
    await sleep(250);
  }
  return {
    pid: child.pid,
    kill: () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** 连接一个 CDP target 的 WebSocket。 */
export class CdpSession {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`WebSocket 连接失败：${wsUrl}`));
    });
    const s = new CdpSession(ws);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const p = s.pending.get(msg.id);
        if (!p) return;
        s.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of s.listeners.get(msg.method) ?? []) {
        try { fn(msg.params); } catch { /* 监听器异常不中断协议 */ }
      }
    };
    ws.onclose = () => {
      for (const [, p] of s.pending) p.reject(new Error('CDP 连接已关闭'));
      s.pending.clear();
    };
    return s;
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值一段 JS，returnByValue 直接拿结果。 */
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面 JS 异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** 连接调试端口上的第一个 page target（Chrome 或 WebView2 均适用）。 */
export async function connectFirstPage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const target = list.find((t) => t.type === 'page') ?? list[0];
  if (!target) throw new Error(`调试端口 ${port} 上没有 page target（targets: ${list.map((t) => t.type).join(',') || '空'}）`);
  return CdpSession.open(target.webSocketDebuggerUrl);
}

export { sleep };
