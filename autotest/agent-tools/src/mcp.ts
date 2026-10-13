// MCP stdio server（骨架版）——把同一套命令规格以 MCP 工具面暴露。
// 传输：JSON-RPC 2.0 over stdio（newline-delimited JSON，MCP stdio 规范）。
// 协议面：initialize / notifications.initialized（忽略）/ ping / tools/list / tools/call。
//  stdout 只写 JSON-RPC 消息；任何日志/告警走 stderr（否则污染协议流）。
import { createInterface } from 'node:readline';
import { allCommands, buildRequest, getCommand, toInputSchema, toToolDescription } from './core/registry.js';
import { apiRequest, resolveClient } from './core/client.js';
import { ApiError, LocalValidationError } from './core/envelope.js';
import { SERVER_INFO } from './core/meta.js';

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  const payload = err instanceof ApiError || err instanceof LocalValidationError
    ? { ok: false, error: { code: err.code, message: err.message, statusCode: (err as ApiError).statusCode || undefined } }
    : { ok: false, error: { code: 'INTERNAL', message: (err as Error).message } };
  return { ...textResult(payload), isError: true };
}

interface JsonRpcMsg {
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

async function handle(msg: JsonRpcMsg): Promise<void> {
  const { id, method, params } = msg;
  // 通知（无 id）不回应——MCP 允许 notifications/initialized 等单向消息
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          // 回声客户端协议版本（协商）；缺省用常见修订
          protocolVersion: String(params?.protocolVersion ?? '2024-11-05'),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: allCommands().map((c) => ({
            name: c.name,
            description: toToolDescription(c),
            inputSchema: toInputSchema(c),
          })),
        },
      });
      return;
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const spec = getCommand(name);
      if (!spec) {
        send({ jsonrpc: '2.0', id, result: errorResult(new LocalValidationError(`未知工具：${name}（tools/list 查看可用集）`)) });
        return;
      }
      try {
        const req = buildRequest(spec, args);
        const client = resolveClient({});
        const res = await apiRequest(client, req);
        // 二进制导出：MCP 无文件系统约定，回 base64 + 文件名，由调用方落盘
        if (res.binary) {
          const buf = res.data as unknown as Buffer;
          send({
            jsonrpc: '2.0',
            id,
            result: textResult({
              ok: true, command: name,
              data: { filename: res.filename ?? 'export.xlsx', bytes: buf.length, base64: buf.toString('base64') },
              meta: { url: res.url, durationMs: res.durationMs },
            }),
          });
          return;
        }
        send({
          jsonrpc: '2.0',
          id,
          result: textResult({ ok: true, command: name, data: res.data, meta: { url: res.url, durationMs: res.durationMs } }),
        });
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: errorResult(e) });
      }
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: JsonRpcMsg;
  try {
    msg = JSON.parse(trimmed) as JsonRpcMsg;
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error：不是合法 JSON 行' } });
    return;
  }
  void handle(msg).catch((e) => {
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } });
  });
});
