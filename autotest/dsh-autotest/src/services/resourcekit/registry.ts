// resourcekit 登记层：把测试资源落库，管理 sha256、版本、复用与临期。
//
// 职责边界：contract.ts 负责"资源长什么样、怎么校验、怎么合成"（纯函数），
// 本文件负责"资源在哪、登记了没有、复用几次、何时过期"（IO）。
//
// 三条纪律：
//   1. **resource_id 是稳定主键**：同一资源重复登记不新建行，只更新内容哈希与复用计数
//      ——否则"同一个 lottie-minimal"会出现 N 行，复用统计失去意义；
//   2. **校验失败也要登记，但要标出来**：validated=0 + valid_problems 记录原因。
//      静默丢弃会让"为什么这个资源没被用上"无从查起；
//   3. **临期要可见**：证书类资源带 expires_at，低于 CA_EXPIRY_WARN_DAYS 应被检出，
//      否则测试会在某天突然全失败（证书过期），而没人知道为什么。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../../db/connection.js';
import {
  RESOURCE_KINDS, validateAnimationJson, synthesizeAnimation, contentHash,
  DEFAULT_CA_SPEC, CA_EXPIRY_WARN_DAYS, caExpectedArtifacts,
  type ResourceKind, type ResourceOrigin, type SyntheticAnimation,
} from './contract.js';

export interface ResourceRow {
  id: number;
  resourceId: string;
  kind: ResourceKind;
  origin: ResourceOrigin;
  scopeKind: string;
  scopeKey: string;
  libraryId: number | null;
  generator: string;
  filePath: string;
  fileSha256: string;
  fileSize: number;
  validated: boolean;
  validProblems: string[];
  intent: string;
  reuseCount: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterInput {
  resourceId: string;
  kind: ResourceKind;
  origin: ResourceOrigin;
  /** 资源内容（合成资源直接给文本；仓库检出的由调用方读文件后传入） */
  content?: string;
  /** 或直接给文件路径（仓库检出） */
  filePath?: string;
  scopeKind?: 'global' | 'library_kind' | 'library';
  scopeKey?: string;
  libraryId?: number | null;
  generator?: string;
  intent?: string;
  /** 证书类资源的过期时间（ISO 或 yyyy-mm-dd） */
  expiresAt?: string | null;
}

function toRow(r: Record<string, unknown>): ResourceRow {
  return {
    id: Number(r.id), resourceId: String(r.resource_id), kind: String(r.kind) as ResourceKind,
    origin: String(r.origin) as ResourceOrigin, scopeKind: String(r.scope_kind ?? 'global'),
    scopeKey: String(r.scope_key ?? ''), libraryId: r.library_id === null ? null : Number(r.library_id),
    generator: String(r.generator ?? ''), filePath: String(r.file_path ?? ''),
    fileSha256: String(r.file_sha256 ?? ''), fileSize: Number(r.file_size ?? 0),
    validated: Number(r.validated ?? 0) === 1,
    validProblems: (() => { try { return JSON.parse(String(r.valid_problems ?? '[]')); } catch { return []; } })(),
    intent: String(r.intent ?? ''), reuseCount: Number(r.reuse_count ?? 0),
    expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ''), updatedAt: String(r.updated_at ?? ''),
  };
}

/**
 * 登记一个资源。幂等：同 resource_id 已存在则更新（内容变了会记新版本），不新建行。
 */
export async function registerResource(input: RegisterInput): Promise<{ ok: boolean; id: number; problems: string[]; versionBumped: boolean }> {
  if (!RESOURCE_KINDS.includes(input.kind)) {
    return { ok: false, id: 0, problems: [`未知资源类型：${String(input.kind)}`], versionBumped: false };
  }
  const db = getDb();

  // 取内容：优先直接给文本，否则读文件
  let content = input.content;
  let filePath = input.filePath ?? '';
  if (content === undefined && filePath) {
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { return { ok: false, id: 0, problems: [`读不到资源文件：${filePath}`], versionBumped: false }; }
  }
  if (content === undefined) {
    return { ok: false, id: 0, problems: ['必须提供 content 或 filePath 之一'], versionBumped: false };
  }

  const sha = contentHash(content);
  const size = Buffer.byteLength(content, 'utf8');

  // schema 校验（目前 animation_json 有校验器；其它类型留待各自 schema 就位）
  const problems: string[] = [];
  if (input.kind === 'animation_json') {
    // malformed / bad-encoding 天生不合法——那是**故意**的边界资源，
    // 校验失败是预期结果，此时 problems 记录原因但不阻塞登记。
    let parsed: unknown = null;
    try { parsed = JSON.parse(content); } catch (e) { problems.push(`JSON 解析失败（可能是故意的畸形资源）：${(e as Error).message}`); }
    if (parsed !== null) problems.push(...validateAnimationJson(parsed).map((p) => `${p.path}: ${p.reason}`));
  }

  const t = now();
  const existing = await db.prepare('SELECT id, file_sha256 FROM test_resources WHERE resource_id = ?')
    .get<{ id: number; file_sha256: string }>(input.resourceId);
  const versionBumped = !!existing && existing.file_sha256 !== sha;

  if (existing) {
    await db.prepare(`UPDATE test_resources SET kind=?, origin=?, scope_kind=?, scope_key=?, library_id=?,
      generator=?, file_path=?, file_sha256=?, file_size=?, validated=?, valid_problems=?, intent=?, expires_at=?, updated_at=?
      WHERE id=?`)
      .run(input.kind, input.origin, input.scopeKind ?? 'global', input.scopeKey ?? '', input.libraryId ?? null,
        input.generator ?? '', filePath, sha, size, problems.length === 0 ? 1 : 0, JSON.stringify(problems),
        input.intent ?? '', input.expiresAt ?? null, t, existing.id);
    if (versionBumped) await recordVersion(input.resourceId, sha, `内容变化：${existing.file_sha256.slice(0, 8)} → ${sha.slice(0, 8)}`);
    return { ok: true, id: existing.id, problems, versionBumped };
  }

  const ins = await db.prepare(`INSERT INTO test_resources
    (resource_id, kind, origin, scope_kind, scope_key, library_id, generator, schema_kind, schema_version,
     file_path, file_sha256, file_size, validated, valid_problems, intent, reuse_count, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(input.resourceId, input.kind, input.origin, input.scopeKind ?? 'global', input.scopeKey ?? '',
      input.libraryId ?? null, input.generator ?? '', filePath, sha, size,
      problems.length === 0 ? 1 : 0, JSON.stringify(problems), input.intent ?? '', input.expiresAt ?? null, t, t);
  await recordVersion(input.resourceId, sha, '首次登记');
  return { ok: true, id: Number(ins.lastInsertRowid), problems, versionBumped: false };
}

async function recordVersion(resourceId: string, sha: string, note: string): Promise<void> {
  const n = (await getDb().prepare('SELECT COUNT(*) AS n FROM test_resource_versions WHERE resource_id = ?').get<{ n: number }>(resourceId))?.n ?? 0;
  await getDb().prepare(`INSERT INTO test_resource_versions (resource_id, version, file_sha256, note, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(resource_id, version) DO UPDATE SET file_sha256=?, note=?`)
    .run(resourceId, `v${n + 1}`, sha, note, now(), sha, note);
}

/** 把某类别的全部合成资源登记一遍（幂等；预设驱动）。 */
export async function registerSyntheticForKind(kind: 'animation' | 'storage' | 'network' | 'codec' | 'ui_component'): Promise<{
  registered: number; problems: number; ids: string[];
}> {
  const ids: string[] = [];
  let problems = 0;

  if (kind === 'animation') {
    const variants: Array<[SyntheticAnimation, string]> = [
      ['lottie-minimal', '基本解析链路：单 shape 图层'],
      ['lottie-empty-layers', '空值场景：layers 为空数组'],
      ['lottie-huge-layers', '大数据场景：200 图层'],
      ['lottie-nested-precomp', '递归解析：嵌套预合成'],
      ['lottie-malformed', '畸形 JSON：截断（必须走错误回调）'],
      ['lottie-bad-encoding', '编码错误：非法 UTF-8 与 NUL'],
    ];
    for (const [variant, intent] of variants) {
      const gen = synthesizeAnimation(variant);
      const r = await registerResource({
        resourceId: variant, kind: 'animation_json', origin: 'synthesized',
        scopeKind: 'library_kind', scopeKey: 'animation', generator: 'synthesizeAnimation',
        content: gen.text, intent,
      });
      ids.push(variant);
      if (r.problems.length > 0) problems++;
    }
  }
  // 其它类别的合成资源在各自 preset 就位后按同一模式补全（storage/network/codec）。
  return { registered: ids.length, problems, ids };
}

/** 资源清单（可按类型/作用域过滤）。 */
export async function listResources(opts: { kind?: ResourceKind; scopeKey?: string; libraryId?: number } = {}): Promise<ResourceRow[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.kind) { conds.push('kind = ?'); args.push(opts.kind); }
  if (opts.scopeKey) { conds.push('scope_key = ?'); args.push(opts.scopeKey); }
  if (opts.libraryId) { conds.push('library_id = ?'); args.push(opts.libraryId); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await getDb().prepare(`SELECT * FROM test_resources ${where} ORDER BY id DESC LIMIT 500`).all<Record<string, unknown>>(...args);
  return rows.map(toRow);
}

/** 记录一次复用（执行时调用；复用次数是"资源是否真有价值"的度量）。 */
export async function bumpReuse(resourceId: string): Promise<void> {
  await getDb().prepare('UPDATE test_resources SET reuse_count = reuse_count + 1, updated_at = ? WHERE resource_id = ?').run(now(), resourceId);
}

/** 检出临期与临近期的证书资源（运维价值：避免某天测试突然全失败）。 */
export async function expiringCerts(withinDays = CA_EXPIRY_WARN_DAYS): Promise<ResourceRow[]> {
  const rows = await getDb().prepare(
    "SELECT * FROM test_resources WHERE kind = 'ca_cert' AND expires_at IS NOT NULL AND expires_at != '' ORDER BY expires_at",
  ).all<Record<string, unknown>>();
  const cutoff = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  return rows.map(toRow).filter((r) => (r.expiresAt ?? '9999') <= cutoff);
}

/** 证书构造规格导出（供 gen-ca 脚本与上层使用）。 */
export { DEFAULT_CA_SPEC, CA_EXPIRY_WARN_DAYS, caExpectedArtifacts };

/** 资源根目录（合成资源落盘处；随包目录之外，属工作区）。 */
export async function resourceStoreRoot(): Promise<string> {
  // 动态 import 避免 registry → gitRepo → ... 的静态环（gitRepo 也引用 db/connection）
  const { workspaceDir } = await import('../gitRepo.js');
  return path.join(workspaceDir(), 'resources');
}
