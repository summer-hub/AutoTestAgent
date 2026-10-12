// 结构化日志（P0-3）：AUTOTEST_LOG_FORMAT=json 时输出 JSON 行（level/msg/time + 字段），
// 默认文本模式（console.* 观感不变，零感知）。
//
// 边界（刻意收敛，避免半吊子改造）：本模块只服务**新增代码路径**与**请求日志**；
// 存量 console.* 调用不逐一重写（改动面与回归风险不成比例）。json 模式下请求日志
// 每行一条（method/route/status/durationMs），可直接进 ELK/Loki。
let jsonMode = String(process.env.AUTOTEST_LOG_FORMAT ?? '').toLowerCase() === 'json';

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (!jsonMode) {
    // 文本模式：与既有 console 用法保持一致
    if (level === 'error') console.error(msg, ...(fields ? [fields] : []));
    else if (level === 'warn') console.warn(msg, ...(fields ? [fields] : []));
    else console.log(msg, ...(fields ? [fields] : []));
    return;
  }
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>): void => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>): void => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>): void => emit('error', msg, fields),
  /** 请求日志（仅 json 模式输出；文本模式不打，避免日志泛滥） */
  request: (method: string, route: string, status: number, durationMs: number, extra?: Record<string, unknown>): void => {
    if (!jsonMode) return;
    emit('info', 'http_request', { method, route, status, durationMs: Number(durationMs.toFixed(1)), ...extra });
  },
};

export function jsonLogEnabled(): boolean {
  return jsonMode;
}
