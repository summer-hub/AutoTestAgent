// resourcekit 契约层：测试资源的种类、schema 校验与生成器规格。
//
// 为什么需要它（用户原话："lottie 的测试资源有 json 资源，这些 json 资源该如何去找，
// 怎么测试"）：资源不能靠 AI 每次现场编——那会让结果不可复现、无法回归。
// 资源必须**模板化 + 登记 + 复用**：三类来源（仓库检出 / 上游 canonical / 程序合成），
// 全部带 sha256 与 schema 校验，构造失败率可度量。
//
// 本文件是纯函数区（无 IO、无 DB）：schema 校验、合成资源的内容生成都在这里，
// 由 verify-resourcekit 离线覆盖。
import { createHash } from 'node:crypto';

export const RESOURCE_KINDS = [
  'animation_json', 'ca_cert', 'server_fixture', 'db_fixture', 'image', 'media', 'config',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = {
  animation_json: '动画 JSON', ca_cert: 'CA 证书', server_fixture: '服务端 fixture',
  db_fixture: '数据库 fixture', image: '图片', media: '音视频', config: '配置文件',
};

/** 资源来源。repo_scan = 仓库自带；canonical = 上游官方样本；synthesized = 程序合成。 */
export const RESOURCE_ORIGINS = ['repo_scan', 'canonical', 'synthesized'] as const;
export type ResourceOrigin = (typeof RESOURCE_ORIGINS)[number];

export interface SchemaProblem {
  path: string;
  reason: string;
}

// ---------- 动画 JSON（bodymovin / lottie schema） ----------

/**
 * 校验动画 JSON 是否符合 bodymovin 基本 schema。
 *
 * 为什么必须校验：合成的动画 json 是"给库解析的输入"，schema 不对就不是
 * "边界场景"而是"无效输入"——测出来的失败毫无意义（库只是拒绝了一个根本不是
 * lottie 的文件）。校验让"畸形资源"与"合法但边界"区分开。
 *
 * 校验最小集：v / fr / ip / op / w / h / layers 七个必备键，数值范围合理，
 * layers 是数组。故意**不**校验 layers 内部结构——那是库的实现细节，
 * 平台只保证"这是一个合法的 lottie 容器"。
 */
export function validateAnimationJson(obj: unknown): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const at = (p: string, r: string) => problems.push({ path: p, reason: r });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return [{ path: '$', reason: '根节点必须是对象' }];
  }
  const o = obj as Record<string, unknown>;
  for (const k of ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers'] as const) {
    if (!(k in o)) at(`$.${k}`, `缺少必备字段 ${k}（bodymovin schema）`);
  }
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : NaN);
  if ('fr' in o && !(num('fr') > 0)) at('$.fr', '帧率必须为正数');
  if ('op' in o && 'ip' in o && Number.isFinite(num('ip')) && Number.isFinite(num('op')) && num('op') < num('ip')) {
    at('$.op', '出点(op)不应小于入点(ip)');
  }
  if ('w' in o && !(num('w') > 0)) at('$.w', '宽度必须为正数');
  if ('h' in o && !(num('h') > 0)) at('$.h', '高度必须为正数');
  if ('layers' in o && !Array.isArray(o.layers)) at('$.layers', 'layers 必须是数组（空数组是合法的空值场景）');
  return problems;
}

/** 合成动画 json 的最小骨架（合法 lottie 容器）。 */
function animBase(name: string, layers: unknown[]): Record<string, unknown> {
  return {
    v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 200, nm: name, ddd: 0,
    assets: [], fonts: { list: [] }, layers, markers: [],
  };
}

/** 一个最小的 shape 图层（合成资源用，不求视觉正确，只求 schema 合法）。 */
function shapeLayer(nm: string): Record<string, unknown> {
  return {
    ddd: 0, ind: 1, ty: 4, nm, sr: 1,
    ks: {
      o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [100, 100, 0] },
      a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
    },
    ao: 0, shapes: [], ip: 0, op: 60, st: 0, bm: 0,
  };
}

/** 嵌套预合成图层（引用 assets 里的合成）。 */
function precompLayer(nm: string, refId: string): Record<string, unknown> {
  return { ...shapeLayer(nm), ty: 0, refId, w: 200, h: 200 };
}

export type SyntheticAnimation =
  | 'lottie-minimal' | 'lottie-empty-layers' | 'lottie-huge-layers'
  | 'lottie-nested-precomp' | 'lottie-malformed' | 'lottie-bad-encoding';

/**
 * 合成动画资源。返回**文本内容**（不是对象）——因为 malformed / bad-encoding
 * 天生就不是合法 JSON，用对象表达不了。
 *
 * 每个变体对应一类测试意图（这是"怎么测试"的答案）：
 *   minimal        → 基本解析链路通不通
 *   empty-layers   → 空值场景（合法但无内容）
 *   huge-layers    → 大数据场景（性能与内存）
 *   nested-precomp → 递归解析（嵌套预合成）
 *   malformed      → 畸形 JSON（必须走 error 回调）
 *   bad-encoding   → 编码错误（UTF-8 BOM / 非法字节）
 */
export function synthesizeAnimation(kind: SyntheticAnimation): { text: string; valid: boolean; intent: string } {
  switch (kind) {
    case 'lottie-minimal':
      return { text: JSON.stringify(animBase('minimal', [shapeLayer('shape-1')]), null, 1), valid: true, intent: '基本解析链路：单 shape 图层' };
    case 'lottie-empty-layers':
      return { text: JSON.stringify(animBase('empty', []), null, 1), valid: true, intent: '空值场景：layers 为空数组（合法但无内容）' };
    case 'lottie-huge-layers': {
      const layers = Array.from({ length: 200 }, (_, i) => shapeLayer(`layer-${i}`));
      return { text: JSON.stringify(animBase('huge', layers), null, 0), valid: true, intent: '大数据场景：200 图层（验证性能与内存）' };
    }
    case 'lottie-nested-precomp': {
      const inner = animBase('precomp-inner', [shapeLayer('inner-shape')]);
      const outer = animBase('nested', [precompLayer('precomp-1', 'precomp-inner')]);
      // assets 里注册被引用的合成
      (outer.assets as unknown[]).push({ id: 'precomp-inner', ...inner });
      return { text: JSON.stringify(outer, null, 1), valid: true, intent: '递归解析：嵌套预合成' };
    }
    case 'lottie-malformed':
      // 截断的 JSON：语法错误，必须走 error 回调
      return { text: '{"v":"5.7.4","fr":30,"layers":[{"ind":1,"ty":4', valid: false, intent: '畸形 JSON：截断（必须走 error 回调且 hilog 有错误码）' };
    case 'lottie-bad-encoding':
      // 合法 JSON 但含非法 UTF-8 字节（\xFF 不是合法 UTF-8 序列）
      return { text: '{"v":"5.7.4","fr":30,"nm":"\uFFFD\uFFFD","layers":[]}\u0000\u0000', valid: false, intent: '编码错误：非法 UTF-8 字节与 NUL（必须走错误回调）' };
  }
}

/** 合成资源的内容哈希（sha256 前 32 位，与 envkit 指纹同规格）。 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

// ---------- CA 证书 ----------

/**
 * CA 证书构造的**规格**（不是实现）。
 *
 * 为什么只给规格：证书生成要调 openssl，而 openssl 的调用方式（参数、输出格式）
 * 属于脚本层（assets/env/gen-ca.{ps1,sh}）。这里只规定"构造出来的东西长什么样"，
 * 供上层校验产物是否合格。
 */
export interface CaSpec {
  cn: string;
  /** 使用者服务器名（SAN），如 localhost、127.0.0.1 */
  san: string[];
  days: number;
  /** 是否生成服务端证书（否则只出 CA） */
  withServerCert: boolean;
}

export const DEFAULT_CA_SPEC: CaSpec = {
  cn: 'AutoTest Local CA', san: ['localhost', '127.0.0.1'], days: 825, withServerCert: true,
};

/** 证书有效期临期阈值（天）：低于此值应提醒更新，否则测试会突然全失败。 */
export const CA_EXPIRY_WARN_DAYS = 30;

/** 证书产物清单（生成后按此校验）。 */
export function caExpectedArtifacts(spec: CaSpec = DEFAULT_CA_SPEC): string[] {
  const base = spec.cn.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const out = [`${base}-ca.crt`, `${base}-ca.key`];
  if (spec.withServerCert) out.push(`${base}-server.crt`, `${base}-server.key`, `${base}-server.p12`);
  return out;
}

// ---------- 数据库 fixture ----------

export interface DbFixtureSpec {
  table: string;
  columns: string[];
  rows: number;
  /** corrupt 变体会写出损坏文件 */
  corrupt?: boolean;
}

/** 生成 SQLite fixture 的 SQL 文本（由脚本层落盘执行）。 */
export function synthesizeDbSql(spec: DbFixtureSpec): string {
  const cols = spec.columns.map((c) => `"${c}"`).join(', ');
  const stmts: string[] = [`CREATE TABLE IF NOT EXISTS "${spec.table}" (${spec.columns.map((c) => `"${c}" TEXT`).join(', ')});`];
  if (spec.corrupt) {
    // 损坏 fixture：合法 SQL 后追加垃圾字节的占位说明（脚本层写坏文件）
    stmts.push('-- CORRUPT: 脚本层将在此处截断文件以构造损坏库');
    return stmts.join('\n');
  }
  for (let i = 0; i < spec.rows; i++) {
    const vals = spec.columns.map((_, j) => `'r${i}c${j}'`).join(', ');
    stmts.push(`INSERT INTO "${spec.table}" (${cols}) VALUES (${vals});`);
  }
  return stmts.join('\n');
}

// ---------- 服务端 fixture ----------

export interface ServerFixtureSpec {
  status: number;
  /** 响应体（JSON 字符串） */
  body: string;
  /** 延迟毫秒（验证超时分支） */
  delayMs?: number;
  /**  Content-Type */
  contentType?: string;
}

/** mock server 的响应规格（脚本层据此起本地服务）。 */
export const DEFAULT_SERVER_FIXTURES: ServerFixtureSpec[] = [
  { status: 200, body: '{"ok":true,"data":[1,2,3]}', contentType: 'application/json' },
  { status: 400, body: '{"error":"bad_request"}', contentType: 'application/json' },
  { status: 500, body: '{"error":"internal"}', contentType: 'application/json' },
  { status: 200, body: '{"ok":true}', delayMs: 30000, contentType: 'application/json' },   // 超时分支
];
