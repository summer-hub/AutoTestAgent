// B2：场景资产服务（设计：docs/设计-独立版产品化与测试基线追溯.md §8 / §10.6）
//  - scenario_assets：测试场景资产主表（OneBox 链接 / demo 页面 / fixture / config / mixed）
//  - 与 test_resources 分工：后者是"数据类资源"，本服务管"场景资产"（有入口、有配置指导、可版本、可关联用例）
//  - 本地资产目录：<workspace>/scenario-assets/<lib>/<assetNo>/（manifest.json + README.md + files）
//  - 不变量：不修改 baseline；应用只写 runs 运行副本（运行副本机制未引入前只做登记）
//  - 上传安全：路径逐段拒绝 ..；大小限制（scenarioAsset.maxFileMb / maxTotalMb）；OneBox 只允许 http/https
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { workspaceDir } from './gitRepo.js';
import { getSetting } from './settings.js';

export type AssetKind = 'onebox_link' | 'demo_page' | 'fixture' | 'config' | 'mixed';
export type ScenarioKind = 'happy' | 'empty' | 'boundary' | 'bigdata' | 'general';

export const ASSET_KINDS: AssetKind[] = ['onebox_link', 'demo_page', 'fixture', 'config', 'mixed'];
export const SCENARIO_KINDS: ScenarioKind[] = ['happy', 'empty', 'boundary', 'bigdata', 'general'];

/** 本地文件资产（有 rel_dir + files）；onebox_link 只存链接与指导。 */
export const LOCAL_KINDS: AssetKind[] = ['demo_page', 'fixture', 'config', 'mixed'];

export interface ScenarioAssetRow {
  id: number;
  asset_no: string;
  library_id: number;
  title: string;
  kind: string;
  scenario_kind: string;
  uri: string;
  rel_dir: string;
  entry_hint: string;
  config_guide_md: string;
  compat_json: string;
  status: string;
  version: string;
  sha256: string;
  validation_json: string;
  validated_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ScenarioAssetFileRow {
  id: number;
  asset_id: number;
  rel_path: string;
  sha256: string;
  size: number;
  role: string;
  created_at: string;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------- 编号 ----------

async function nextNo(prefix: string, table: string, col: string): Promise<string> {
  const db = getDb();
  const date = now().slice(0, 10).replace(/-/g, '');
  const like = `${prefix}-${date}-%`;
  // CAST(SUBSTRING(x AS UNSIGNED))：MySQL 原生；SQLite 由 connection 的方言翻译自动转成 AS INTEGER
  const row = await db.prepare(
    `SELECT MAX(CAST(SUBSTRING(${col}, ${prefix.length + date.length + 3}) AS UNSIGNED)) AS m FROM ${table} WHERE ${col} LIKE ?`,
  ).get<{ m: number | null }>(like);
  const seq = (row?.m ?? 0) + 1;
  return `${prefix}-${date}-${String(seq).padStart(3, '0')}`;
}

export async function nextAssetNo(): Promise<string> {
  return nextNo('SA', 'scenario_assets', 'asset_no');
}

export async function nextSetNo(): Promise<string> {
  return nextNo('RS', 'test_resource_sets', 'set_no');
}

// ---------- 目录 ----------

/** 库名 → 安全目录名（与工作区其他目录同一套清洗规则）。 */
function libDirName(libName: string): string {
  const cleaned = libName.trim().replace(/[\\/:*?"<>|\s]+/g, '_');
  return cleaned || 'lib';
}

/** 场景资产根目录：<workspace>/scenario-assets。 */
export function assetsRootDir(): string {
  const dir = path.join(workspaceDir(), 'scenario-assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assetAbsDir(asset: Pick<ScenarioAssetRow, 'rel_dir'>): string {
  return path.join(workspaceDir(), asset.rel_dir);
}

function ensureAssetDir(asset: ScenarioAssetRow): string {
  const dir = assetAbsDir(asset);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- 路径与大小安全 ----------

/**
 * 相对路径安全校验（设计 §10.6 注）：逐段拒绝 `..`、绝对路径、盘符、空段、.git；
 * 保留字 manifest.json / README.md（根级生成文件）不允许用户文件占用。
 */
export function safeRelPath(input: string): string {
  const raw = String(input ?? '');
  if (!raw || raw.length > 200 || raw.includes('\0')) throw httpError(400, '文件路径为空或非法。');
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw httpError(400, `文件路径必须是相对路径：${raw}`);
  const segments = p.split('/');
  const bad = segments.find((s) => s === '' || s === '.' || s === '..' || s === '.git' || s === '.hg');
  if (bad !== undefined) throw httpError(400, `文件路径含非法段「${bad}」：${raw}`);
  if (segments[0].toLowerCase() === 'manifest.json' || segments[0].toLowerCase() === 'readme.md') {
    throw httpError(400, 'manifest.json / README.md 由系统生成，不允许作为上传文件名。');
  }
  return segments.join('/');
}

function maxFileBytes(): number {
  const v = Number(getSetting('scenarioAsset.maxFileMb', 2));
  return (Number.isFinite(v) && v > 0 ? v : 2) * 1024 * 1024;
}

function maxTotalBytes(): number {
  const v = Number(getSetting('scenarioAsset.maxTotalMb', 20));
  return (Number.isFinite(v) && v > 0 ? v : 20) * 1024 * 1024;
}

function decodeBase64File(contentBase64: string, relPath: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(String(contentBase64 ?? ''), 'base64');
  } catch {
    throw httpError(400, `文件 ${relPath} 的 base64 内容无法解码。`);
  }
  if (buf.length === 0) throw httpError(400, `文件 ${relPath} 内容为空。`);
  if (buf.length > maxFileBytes()) {
    throw httpError(400, `文件 ${relPath} 大小 ${(buf.length / 1024 / 1024).toFixed(2)}MB 超过单文件上限 ${getSetting('scenarioAsset.maxFileMb', 2)}MB。`);
  }
  return buf;
}

// ---------- manifest / 版本 ----------

interface ManifestCompat { minVersion?: string; maxVersion?: string; commit?: string }

function parseCompat(raw: string): ManifestCompat {
  try {
    const v = JSON.parse(raw) as ManifestCompat;
    return {
      minVersion: typeof v.minVersion === 'string' ? v.minVersion : '',
      maxVersion: typeof v.maxVersion === 'string' ? v.maxVersion : '',
      commit: typeof v.commit === 'string' ? v.commit : '',
    };
  } catch {
    return { minVersion: '', maxVersion: '', commit: '' };
  }
}

/** 资产内容指纹：按 rel_path 排序的文件清单哈希（文件集合不变则指纹不变）。 */
function combinedSha(files: Array<{ rel_path: string; sha256: string; size: number }>): string {
  if (files.length === 0) return '';
  const lines = [...files].sort((a, b) => (a.rel_path < b.rel_path ? -1 : 1))
    .map((f) => `${f.rel_path}:${f.sha256}:${f.size}`);
  return sha256Hex(lines.join('\n'));
}

/** 把 manifest.json + README.md 写到资产目录（每次文件/指导变更后重生成）。 */
function writeManifestAndReadme(asset: ScenarioAssetRow, files: ScenarioAssetFileRow[]): void {
  const dir = ensureAssetDir(asset);
  const manifest = {
    schemaVersion: 1,
    assetNo: asset.asset_no,
    libraryId: asset.library_id,
    kind: asset.kind,
    scenarioKind: asset.scenario_kind,
    version: asset.version,
    sha256: combinedSha(files),
    uri: asset.uri,
    entryHint: asset.entry_hint,
    configGuideMd: asset.config_guide_md,
    compat: parseCompat(asset.compat_json),
    files: [...files].sort((a, b) => (a.rel_path < b.rel_path ? -1 : 1))
      .map((f) => ({ path: f.rel_path, sha256: f.sha256, size: f.size, role: f.role })),
    generatedAt: now(),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const readme = `# ${asset.asset_no} ${asset.title}\n\n` +
    `- 类型：${asset.kind} / 场景：${asset.scenario_kind}\n` +
    `- 版本：${asset.version}（sha256 ${manifest.sha256 || '（无文件）'}）\n` +
    (asset.uri ? `- 链接：${asset.uri}\n` : '') +
    (asset.entry_hint ? `- 入口提示：${asset.entry_hint}\n` : '') +
    `\n---\n\n${asset.config_guide_md || '（无配置指导）'}\n`;
  fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
}

async function getAssetOr404(id: number): Promise<ScenarioAssetRow> {
  const asset = await getDb().prepare('SELECT * FROM scenario_assets WHERE id = ?').get<ScenarioAssetRow>(Number(id));
  if (!asset) throw httpError(404, `场景资产 #${id} 不存在。`);
  return asset;
}

// ---------- CRUD ----------

export interface CreateAssetInput {
  libraryId: number;
  title: string;
  kind: AssetKind;
  scenarioKind?: ScenarioKind;
  uri?: string;
  entryHint?: string;
  configGuideMd?: string;
  compat?: ManifestCompat;
  createdBy?: string;
}

export async function createAsset(input: CreateAssetInput): Promise<ScenarioAssetRow> {
  const db = getDb();
  const title = String(input.title ?? '').trim();
  if (!title) throw httpError(400, '资产标题不能为空。');
  if (!ASSET_KINDS.includes(input.kind)) throw httpError(400, `kind 必须是 ${ASSET_KINDS.join(' / ')} 之一。`);
  const scenarioKind = input.scenarioKind ?? 'general';
  if (!SCENARIO_KINDS.includes(scenarioKind)) throw httpError(400, `scenarioKind 必须是 ${SCENARIO_KINDS.join(' / ')} 之一。`);

  const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(Number(input.libraryId));
  if (!lib) throw httpError(404, `库 #${input.libraryId} 不存在。`);

  const uri = String(input.uri ?? '').trim();
  const guide = String(input.configGuideMd ?? '').trim();
  if (input.kind === 'onebox_link') {
    if (!/^https?:\/\//.test(uri)) throw httpError(400, 'OneBox 链接资产必须提供 http/https 链接。');
    if (!guide) throw httpError(400, 'OneBox 链接资产必须填写配置指导（configGuideMd）。');
  }
  if (input.kind === 'config' && !guide) throw httpError(400, 'config 类型资产必须填写配置指导（configGuideMd）。');

  const assetNo = await nextAssetNo();
  const t = now();
  const relDir = input.kind === 'onebox_link'
    ? ''
    : `scenario-assets/${libDirName(lib.name)}/${assetNo}`;
  const compat = input.compat ?? { minVersion: '', maxVersion: '', commit: '' };
  const ins = await db.prepare(
    `INSERT INTO scenario_assets (asset_no, library_id, title, kind, scenario_kind, uri, rel_dir, entry_hint, config_guide_md, compat_json, status, version, sha256, validation_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '1', '', '{}', ?, ?, ?)`,
  ).run(assetNo, lib.id, title, input.kind, scenarioKind, uri, relDir,
    String(input.entryHint ?? ''), guide, JSON.stringify(compat), String(input.createdBy ?? ''), t, t);
  const asset = await getAssetOr404(Number(ins.lastInsertRowid));
  // 初始版本 V1（空文件集合）落版本史 —— 版本 sha256 可查从创建开始（设计 §15.5）
  await db.prepare(
    `INSERT INTO scenario_asset_versions (asset_id, version, sha256, manifest_json, note, created_at) VALUES (?, '1', '', ?, '创建', ?)`,
  ).run(asset.id, JSON.stringify({ files: [], uri: asset.uri }), t);
  if (asset.kind !== 'onebox_link') writeManifestAndReadme(asset, []);
  return asset;
}

export interface ListAssetsOpts { libraryId?: number; kind?: string; status?: string; scenarioKind?: string; q?: string }

export async function listAssets(opts: ListAssetsOpts = {}): Promise<Array<ScenarioAssetRow & { library_name: string; file_count: number; case_count: number }>> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.libraryId) { where.push('sa.library_id = ?'); params.push(Number(opts.libraryId)); }
  if (opts.kind) { where.push('sa.kind = ?'); params.push(opts.kind); }
  if (opts.status) { where.push('sa.status = ?'); params.push(opts.status); }
  if (opts.scenarioKind) { where.push('sa.scenario_kind = ?'); params.push(opts.scenarioKind); }
  if (opts.q) { where.push('(sa.title LIKE ? OR sa.asset_no LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`); }
  const sql = `SELECT sa.*, l.name AS library_name,
      (SELECT COUNT(*) FROM scenario_asset_files f WHERE f.asset_id = sa.id) AS file_count,
      (SELECT COUNT(*) FROM scenario_asset_cases c WHERE c.asset_id = sa.id) AS case_count
    FROM scenario_assets sa JOIN libraries l ON l.id = sa.library_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY sa.updated_at DESC, sa.id DESC LIMIT 500`;
  return db.prepare(sql).all(params);
}

export async function getAssetDetail(id: number): Promise<{
  asset: ScenarioAssetRow & { library_name: string };
  files: ScenarioAssetFileRow[];
  versions: Array<{ id: number; version: string; sha256: string; note: string; created_at: string }>;
  cases: Array<{ case_id: number; case_no: string; name: string; role: string }>;
  requirements: Array<{ requirement_id: number; requirement_no: string; title: string }>;
  runRefs: Array<{ run_item_id: number; run_no: string; asset_id: number; version: string; apply_status: string; created_at: string }>;
}> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(asset.library_id);
  const files = await db.prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ? ORDER BY rel_path').all<ScenarioAssetFileRow>(asset.id);
  const versions = await db.prepare('SELECT id, version, sha256, note, created_at FROM scenario_asset_versions WHERE asset_id = ? ORDER BY CAST(version AS UNSIGNED) DESC')
    .all<{ id: number; version: string; sha256: string; note: string; created_at: string }>(asset.id);
  const cases = await db.prepare(
    `SELECT sac.case_id, sac.role, c.case_no, c.name FROM scenario_asset_cases sac
     JOIN cases c ON c.id = sac.case_id WHERE sac.asset_id = ? ORDER BY c.case_no`,
  ).all<{ case_id: number; case_no: string; name: string; role: string }>(asset.id);
  const requirements = await db.prepare(
    `SELECT sar.requirement_id, r.requirement_no, r.title FROM scenario_asset_requirements sar
     JOIN requirements r ON r.id = sar.requirement_id WHERE sar.asset_id = ? ORDER BY r.requirement_no`,
  ).all<{ requirement_id: number; requirement_no: string; title: string }>(asset.id);
  const runRefs = await db.prepare(
    `SELECT ria.run_item_id, ria.asset_id, ria.version AS version, ria.apply_status, ria.created_at, tr.run_no
     FROM run_item_assets ria
     JOIN test_run_items tri ON tri.id = ria.run_item_id
     JOIN test_runs tr ON tr.id = tri.run_id
     WHERE ria.asset_id = ? ORDER BY ria.created_at DESC LIMIT 50`,
  ).all<{ run_item_id: number; run_no: string; asset_id: number; version: string; apply_status: string; created_at: string }>(asset.id);
  return {
    asset: { ...asset, library_name: lib?.name ?? '' },
    files, versions, cases,
    requirements,
    runRefs,
  };
}

export interface UpdateAssetInput {
  title?: string;
  scenarioKind?: ScenarioKind;
  uri?: string;
  entryHint?: string;
  configGuideMd?: string;
  compat?: ManifestCompat;
}

export async function updateAsset(id: number, input: UpdateAssetInput): Promise<ScenarioAssetRow> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，不能编辑（如需恢复请重新创建）。');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (!t) throw httpError(400, '资产标题不能为空。');
    sets.push('title = ?'); params.push(t);
  }
  if (input.scenarioKind !== undefined) {
    if (!SCENARIO_KINDS.includes(input.scenarioKind)) throw httpError(400, `scenarioKind 必须是 ${SCENARIO_KINDS.join(' / ')} 之一。`);
    sets.push('scenario_kind = ?'); params.push(input.scenarioKind);
  }
  if (input.uri !== undefined) {
    const uri = String(input.uri).trim();
    if (asset.kind === 'onebox_link' && !/^https?:\/\//.test(uri)) throw httpError(400, 'OneBox 链接资产必须提供 http/https 链接。');
    sets.push('uri = ?'); params.push(uri);
  }
  if (input.entryHint !== undefined) { sets.push('entry_hint = ?'); params.push(String(input.entryHint)); }
  if (input.configGuideMd !== undefined) {
    const guide = String(input.configGuideMd).trim();
    if ((asset.kind === 'onebox_link' || asset.kind === 'config') && !guide) {
      throw httpError(400, `${asset.kind} 类型资产必须保留配置指导。`);
    }
    sets.push('config_guide_md = ?'); params.push(guide);
  }
  if (input.compat !== undefined) { sets.push('compat_json = ?'); params.push(JSON.stringify(input.compat)); }
  if (sets.length === 0) return asset;
  sets.push('updated_at = ?'); params.push(now());
  params.push(asset.id);
  await db.prepare(`UPDATE scenario_assets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = await getAssetOr404(asset.id);
  // 指导/入口等元数据进了 manifest —— 同步重生成
  const files = await db.prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ?').all<ScenarioAssetFileRow>(asset.id);
  if (updated.kind !== 'onebox_link') writeManifestAndReadme(updated, files);
  return updated;
}

// ---------- 文件写入 ----------

export interface AssetFileInput { path: string; contentBase64: string; role?: string }

export interface WriteFilesResult {
  asset: ScenarioAssetRow;
  written: Array<{ path: string; sha256: string; size: number; role: string }>;
  version: string;
  totalBytes: number;
}

/**
 * 写入/覆盖一批文件（base64），每次写入版本 +1 并落版本史（sha256 可查，设计 §15.5）。
 * 上传后 status 从 validated 回退 draft（内容变了，旧校验结论不再可信）。
 */
export async function writeAssetFiles(id: number, files: AssetFileInput[], opts: { note?: string; createdBy?: string } = {}): Promise<WriteFilesResult> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，不能上传文件。');
  if (asset.kind === 'onebox_link') throw httpError(400, 'OneBox 链接资产不存本地文件（只存 uri + 配置指导）。');
  if (!Array.isArray(files) || files.length === 0) throw httpError(400, '文件列表不能为空。');
  if (files.length > 100) throw httpError(400, '单次最多上传 100 个文件。');

  const dir = ensureAssetDir(asset);
  const existing = await db.prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ?').all<ScenarioAssetFileRow>(asset.id);
  const byPath = new Map(existing.map((f) => [f.rel_path, f]));
  const written: Array<{ path: string; sha256: string; size: number; role: string; buf: Buffer }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    const rel = safeRelPath(f.path);
    if (seen.has(rel)) throw httpError(400, `文件路径重复：${rel}`);
    seen.add(rel);
    const buf = decodeBase64File(f.contentBase64, rel);
    const sha = sha256Hex(buf);
    written.push({ path: rel, sha256: sha, size: buf.length, role: String(f.role ?? 'page'), buf });
  }
  // 总量校验：新写入替换同路径旧文件，其余旧文件保留
  const replacedBytes = written.reduce((s, w) => s + (byPath.get(w.path)?.size ?? 0), 0);
  const keptBytes = existing.reduce((s, f) => s + f.size, 0) - replacedBytes;
  const newTotal = keptBytes + written.reduce((s, w) => s + w.size, 0);
  if (newTotal > maxTotalBytes()) {
    throw httpError(400, `资产文件总量 ${(newTotal / 1024 / 1024).toFixed(2)}MB 超过上限 ${getSetting('scenarioAsset.maxTotalMb', 20)}MB。`);
  }

  const t = now();
  for (const w of written) {
    const abs = path.join(dir, ...w.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, w.buf);
    const old = byPath.get(w.path);
    if (old) {
      await db.prepare('UPDATE scenario_asset_files SET sha256 = ?, size = ?, role = ? WHERE id = ?').run(w.sha256, w.size, w.role, old.id);
    } else {
      await db.prepare('INSERT INTO scenario_asset_files (asset_id, rel_path, sha256, size, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(asset.id, w.path, w.sha256, w.size, w.role, t);
    }
  }

  const allFiles = await db.prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ? ORDER BY rel_path').all<ScenarioAssetFileRow>(asset.id);
  const nextVersionNum = Math.max(1, ...allFiles.map(() => 0), Number(asset.version) || 1) + 1;
  const nextVersion = String(nextVersionNum);
  const sha = combinedSha(allFiles);
  const status = asset.status === 'validated' ? 'draft' : asset.status;
  await db.prepare('UPDATE scenario_assets SET version = ?, sha256 = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(nextVersion, sha, status, t, asset.id);
  const updatedAsset = await getAssetOr404(asset.id);
  writeManifestAndReadme(updatedAsset, allFiles);
  await db.prepare('INSERT INTO scenario_asset_versions (asset_id, version, sha256, manifest_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(asset.id, nextVersion, sha, JSON.stringify({
      files: allFiles.map((f) => ({ path: f.rel_path, sha256: f.sha256, size: f.size, role: f.role })),
      uri: updatedAsset.uri,
    }), String(opts.note ?? `写入 ${written.length} 个文件`).slice(0, 480), t);
  return {
    asset: updatedAsset,
    written: written.map(({ path: p, sha256: s, size, role }) => ({ path: p, sha256: s, size, role })),
    version: nextVersion,
    totalBytes: newTotal,
  };
}

export async function listAssetFiles(id: number): Promise<ScenarioAssetFileRow[]> {
  const asset = await getAssetOr404(id);
  return getDb().prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ? ORDER BY rel_path').all(asset.id);
}

// ---------- 校验（静态） ----------

export interface ValidateResult {
  ok: boolean;
  level: string;
  problems: string[];
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * 静态校验（设计 §8.5 第 1 级）：目录/manifest/README 存在、逐文件 sha256 与磁盘一致、manifest 与 DB 清单一致、大小限制。
 * compile/device 级暂未支持（返回 400），真机校验待 B4 执行器接入。
 */
export async function validateAsset(id: number, level = 'static'): Promise<ValidateResult> {
  if (level !== 'static') throw httpError(400, `校验级别 ${level} 暂未支持（当前仅 static；compile/device 待执行器接入）。`);
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，无需校验。');
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const problems: string[] = [];

  if (asset.kind === 'onebox_link') {
    const uriOk = /^https?:\/\//.test(asset.uri);
    checks.push({ name: '链接格式（http/https）', ok: uriOk, detail: asset.uri });
    if (!uriOk) problems.push('uri 不是 http/https 链接');
    const guideOk = asset.config_guide_md.trim().length > 0;
    checks.push({ name: '配置指导非空', ok: guideOk });
    if (!guideOk) problems.push('配置指导为空');
  } else {
    const dir = assetAbsDir(asset);
    const dirOk = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    checks.push({ name: '资产目录存在', ok: dirOk, detail: dir });
    if (!dirOk) problems.push(`资产目录不存在：${dir}`);

    const manifestPath = path.join(dir, 'manifest.json');
    let manifest: { assetNo?: string; files?: Array<{ path: string; sha256: string }> } | null = null;
    const manifestExists = fs.existsSync(manifestPath);
    checks.push({ name: 'manifest.json 存在', ok: manifestExists });
    if (!manifestExists) problems.push('manifest.json 缺失');
    if (manifestExists) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { assetNo?: string; files?: Array<{ path: string; sha256: string }> };
        const noOk = manifest.assetNo === asset.asset_no;
        checks.push({ name: 'manifest assetNo 一致', ok: noOk, detail: String(manifest.assetNo ?? '') });
        if (!noOk) problems.push(`manifest assetNo 不一致：${String(manifest.assetNo)}`);
      } catch (e) {
        checks.push({ name: 'manifest.json 可解析', ok: false, detail: (e as Error).message });
        problems.push('manifest.json 解析失败');
      }
    }
    const readmeOk = fs.existsSync(path.join(dir, 'README.md'));
    checks.push({ name: 'README.md 存在', ok: readmeOk });
    if (!readmeOk) problems.push('README.md 缺失');

    const files = await db.prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ?').all<ScenarioAssetFileRow>(asset.id);
    if (files.length === 0) {
      checks.push({ name: '至少一个文件', ok: false });
      problems.push('本地资产尚未上传任何文件');
    }
    let total = 0;
    for (const f of files) {
      const abs = path.join(dir, ...f.rel_path.split('/'));
      if (!fs.existsSync(abs)) {
        checks.push({ name: `文件存在 ${f.rel_path}`, ok: false });
        problems.push(`文件缺失：${f.rel_path}`);
        continue;
      }
      const disk = fs.readFileSync(abs);
      total += disk.length;
      const shaOk = sha256Hex(disk) === f.sha256;
      checks.push({ name: `sha256 一致 ${f.rel_path}`, ok: shaOk });
      if (!shaOk) problems.push(`sha256 不一致：${f.rel_path}`);
    }
    if (total > maxTotalBytes()) {
      checks.push({ name: '总量大小限制', ok: false, detail: `${(total / 1024 / 1024).toFixed(2)}MB` });
      problems.push(`磁盘文件总量超过 ${getSetting('scenarioAsset.maxTotalMb', 20)}MB 限制`);
    }
    if (manifest && manifest.files) {
      const dbPaths = new Set(files.map((f) => f.rel_path));
      const manifestPaths = new Set(manifest.files.map((f) => f.path));
      const drift = [...dbPaths].filter((p) => !manifestPaths.has(p)).concat([...manifestPaths].filter((p) => !dbPaths.has(p)));
      const listOk = drift.length === 0;
      checks.push({ name: 'manifest 文件清单与登记一致', ok: listOk, detail: drift.length ? drift.join(', ') : undefined });
      if (!listOk) problems.push(`manifest 清单漂移：${drift.join(', ')}`);
    }
  }

  const ok = problems.length === 0;
  const t = now();
  const validation = { schemaVersion: 1, level, checkedAt: t, problems, checks };
  await db.prepare('UPDATE scenario_assets SET status = ?, validation_json = ?, validated_at = ?, updated_at = ? WHERE id = ?')
    .run(ok ? 'validated' : 'draft', JSON.stringify(validation), ok ? t : null, t, asset.id);
  return { ok, level, problems, checks };
}

// ---------- 关联 ----------

export async function linkCases(id: number, caseIds: number[], role = 'precondition'): Promise<{ linked: number }> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，不能关联用例。');
  if (!Array.isArray(caseIds) || caseIds.length === 0) throw httpError(400, 'caseIds 不能为空。');
  const t = now();
  let linked = 0;
  for (const cid of caseIds) {
    const c = await db.prepare('SELECT id, library_id FROM cases WHERE id = ?').get<{ id: number; library_id: number }>(Number(cid));
    if (!c) throw httpError(404, `用例 #${cid} 不存在。`);
    if (c.library_id !== asset.library_id) {
      throw httpError(400, `用例 #${cid} 属于其他库，场景资产只能关联同库用例（设计 §8.6）。`);
    }
    const dup = await db.prepare('SELECT asset_id FROM scenario_asset_cases WHERE asset_id = ? AND case_id = ?').get(asset.id, c.id);
    if (dup) continue;
    await db.prepare('INSERT INTO scenario_asset_cases (asset_id, case_id, role, created_at) VALUES (?, ?, ?, ?)').run(asset.id, c.id, role, t);
    linked++;
  }
  if (linked > 0) await db.prepare('UPDATE scenario_assets SET updated_at = ? WHERE id = ?').run(t, asset.id);
  return { linked };
}

export async function linkRequirements(id: number, requirementIds: number[]): Promise<{ linked: number }> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，不能关联需求。');
  if (!Array.isArray(requirementIds) || requirementIds.length === 0) throw httpError(400, 'requirementIds 不能为空。');
  const t = now();
  let linked = 0;
  for (const rid of requirementIds) {
    const r = await db.prepare('SELECT id FROM requirements WHERE id = ?').get<{ id: number }>(Number(rid));
    if (!r) throw httpError(404, `需求 #${rid} 不存在。`);
    const dup = await db.prepare('SELECT asset_id FROM scenario_asset_requirements WHERE asset_id = ? AND requirement_id = ?').get(asset.id, r.id);
    if (dup) continue;
    await db.prepare('INSERT INTO scenario_asset_requirements (asset_id, requirement_id, created_at) VALUES (?, ?, ?)').run(asset.id, r.id, t);
    linked++;
  }
  if (linked > 0) await db.prepare('UPDATE scenario_assets SET updated_at = ? WHERE id = ?').run(t, asset.id);
  return { linked };
}

// ---------- 下架 / 删除 ----------

export async function deprecateAsset(id: number): Promise<ScenarioAssetRow> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status === 'deprecated') return asset;
  const t = now();
  await db.prepare(`UPDATE scenario_assets SET status = 'deprecated', updated_at = ? WHERE id = ?`).run(t, asset.id);
  return getAssetOr404(asset.id);
}

/** 删除仅限 draft/deprecated 且无关联（用例/运行引用）—— 有关联必须走下架（保历史可追溯）。 */
export async function removeAsset(id: number): Promise<{ removed: boolean; dirRemoved: boolean }> {
  const db = getDb();
  const asset = await getAssetOr404(id);
  if (asset.status !== 'draft' && asset.status !== 'deprecated') {
    throw httpError(409, '只有 draft/deprecated 状态的资产可删除（validated 请先下架）。');
  }
  const caseRefs = await db.prepare('SELECT COUNT(*) AS n FROM scenario_asset_cases WHERE asset_id = ?').get<{ n: number }>(asset.id);
  const runRefs = await db.prepare('SELECT COUNT(*) AS n FROM run_item_assets WHERE asset_id = ?').get<{ n: number }>(asset.id);
  if ((caseRefs?.n ?? 0) > 0 || (runRefs?.n ?? 0) > 0) {
    throw httpError(409, `资产已被 ${caseRefs?.n ?? 0} 个用例 / ${runRefs?.n ?? 0} 次运行引用，不能删除（请改为下架）。`);
  }
  await db.prepare('DELETE FROM scenario_asset_files WHERE asset_id = ?').run(asset.id);
  await db.prepare('DELETE FROM scenario_asset_versions WHERE asset_id = ?').run(asset.id);
  await db.prepare('DELETE FROM scenario_asset_requirements WHERE asset_id = ?').run(asset.id);
  await db.prepare('DELETE FROM scenario_assets WHERE id = ?').run(asset.id);
  let dirRemoved = false;
  if (asset.rel_dir) {
    const dir = assetAbsDir(asset);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      dirRemoved = true;
    }
  }
  return { removed: true, dirRemoved };
}

// ---------- 应用（登记制） ----------

export interface ApplyManifest {
  schemaVersion: 1;
  applied: boolean;
  mode: 'recorded';
  note: string;
  assetNo: string;
  version: string;
  sha256: string;
  uri: string;
  entryHint: string;
  configGuideMd: string;
  files: Array<{ path: string; sha256: string; size: number; role: string }>;
  recordedAt: string;
}

/**
 * 构造"登记不注入"的 apply manifest（阶段一：运行副本机制未引入）。
 * 真实注入（copy 到 runs/<runNo>/<lib> 并改 main_pages.json）待运行副本机制落地后启用 —— 失败必须显式标记（设计 §8.4）。
 */
async function buildRecordManifest(asset: ScenarioAssetRow): Promise<ApplyManifest> {
  const files = await getDb().prepare('SELECT rel_path, sha256, size, role FROM scenario_asset_files WHERE asset_id = ? ORDER BY rel_path')
    .all<{ rel_path: string; sha256: string; size: number; role: string }>(asset.id);
  return {
    schemaVersion: 1,
    applied: false,
    mode: 'recorded',
    note: '运行副本机制未引入（执行直跑 workspace/hypium），资产仅登记版本与清单，未注入运行环境。',
    assetNo: asset.asset_no,
    version: asset.version,
    sha256: asset.sha256,
    uri: asset.uri,
    entryHint: asset.entry_hint,
    configGuideMd: asset.config_guide_md,
    files: files.map((f) => ({ path: f.rel_path, sha256: f.sha256, size: f.size, role: f.role })),
    recordedAt: now(),
  };
}

/** 手工"应用到运行"（§10.6 /apply）：当前为登记制 —— 写 run_item_assets（幂等）。 */
export async function applyAssetToRunItem(assetId: number, runItemId: number): Promise<{ assetNo: string; version: string; applyStatus: string }> {
  const db = getDb();
  const asset = await getAssetOr404(assetId);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，不能应用。');
  const item = await db.prepare('SELECT id, run_id, library_id FROM test_run_items WHERE id = ?').get<{ id: number; run_id: number; library_id: number }>(Number(runItemId));
  if (!item) throw httpError(404, `运行项 #${runItemId} 不存在。`);
  if (item.library_id !== asset.library_id) throw httpError(400, '资产与运行项不属于同一个库。');
  const manifest = await buildRecordManifest(asset);
  const dup = await db.prepare('SELECT run_item_id FROM run_item_assets WHERE run_item_id = ? AND asset_id = ?').get(item.id, asset.id);
  if (!dup) {
    await db.prepare('INSERT INTO run_item_assets (run_item_id, asset_id, version, apply_status, manifest_json, created_at) VALUES (?, ?, ?, ' + "'recorded'" + ', ?, ?)')
      .run(item.id, asset.id, asset.version, JSON.stringify(manifest), now());
  }
  return { assetNo: asset.asset_no, version: asset.version, applyStatus: 'recorded' };
}

// ---------- 运行集成（planExecutor 钩子） ----------

export interface ResourceSetRow {
  id: number;
  set_no: string;
  library_id: number;
  name: string;
  manifest_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * 运行开始时为某库 run item 收集关联场景资产（§8.7 资源集合）：
 *  - 按"资产关联的用例 ∈ 本次运行用例集"筛选，同库、未下架；
 *  - 建 test_resource_sets + items（版本/sha 快照）；
 *  - 写 run_item_assets（apply_status='recorded'，登记制）；
 *  - 回填 test_run_items.resource_set_id / test_runs.resource_set_id。
 * 无关联资产返回 null（大多数运行没有场景资产，不产生空资源集）。
 */
export async function recordRunItemAssets(
  runId: number, runItemId: number, libraryId: number, caseIds: number[], runNo: string,
): Promise<{ setId: number; setNo: string; assetCount: number } | null> {
  const db = getDb();
  if (!caseIds.length) return null;
  const ph = caseIds.map(() => '?').join(', ');
  const assets = await db.prepare(
    `SELECT DISTINCT sa.* FROM scenario_assets sa
     JOIN scenario_asset_cases sac ON sac.asset_id = sa.id
     WHERE sa.library_id = ? AND sa.status <> 'deprecated' AND sac.case_id IN (${ph})
     ORDER BY sa.asset_no`,
  ).all<ScenarioAssetRow>(Number(libraryId), ...caseIds);
  if (assets.length === 0) return null;

  const t = now();
  const setNo = await nextSetNo();
  const ins = await db.prepare(
    `INSERT INTO test_resource_sets (set_no, library_id, name, manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(setNo, Number(libraryId), `运行 ${runNo} 资源集`, JSON.stringify({
    schemaVersion: 1,
    runNo,
    assets: assets.map((a) => ({ id: a.id, assetNo: a.asset_no, kind: a.kind, version: a.version, sha256: a.sha256 })),
    note: '场景资产登记制：版本与 sha256 已快照，注入待运行副本机制',
  }), t, t);
  const setId = Number(ins.lastInsertRowid);
  for (const a of assets) {
    await db.prepare(
      `INSERT INTO test_resource_set_items (set_id, kind, ref_id, version, role, sha256, created_at) VALUES (?, 'scenario_asset', ?, ?, 'precondition', ?, ?)`,
    ).run(setId, a.id, a.version, a.sha256, t);
    const dup = await db.prepare('SELECT run_item_id FROM run_item_assets WHERE run_item_id = ? AND asset_id = ?').get(runItemId, a.id);
    if (!dup) {
      const manifest = await buildRecordManifest(a);
      await db.prepare(
        `INSERT INTO run_item_assets (run_item_id, asset_id, version, apply_status, manifest_json, created_at) VALUES (?, ?, ?, 'recorded', ?, ?)`,
      ).run(runItemId, a.id, a.version, JSON.stringify(manifest), t);
    }
  }
  await db.prepare('UPDATE test_run_items SET resource_set_id = ? WHERE id = ?').run(setId, runItemId);
  await db.prepare('UPDATE test_runs SET resource_set_id = ? WHERE id = ?').run(setId, runId);
  return { setId, setNo, assetCount: assets.length };
}

export async function getResourceSet(id: number): Promise<{
  set: ResourceSetRow;
  items: Array<{ id: number; kind: string; ref_id: number; version: string; role: string; sha256: string; created_at: string }>;
}> {
  const db = getDb();
  const set = await db.prepare('SELECT * FROM test_resource_sets WHERE id = ?').get<ResourceSetRow>(Number(id));
  if (!set) throw httpError(404, `资源集 #${id} 不存在。`);
  const items = await db.prepare('SELECT id, kind, ref_id, version, role, sha256, created_at FROM test_resource_set_items WHERE set_id = ? ORDER BY id')
    .all<{ id: number; kind: string; ref_id: number; version: string; role: string; sha256: string; created_at: string }>(set.id);
  return { set, items };
}

// ---------- 下载（zip，零依赖 stored 实现） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** stored（不压缩）zip 打包：服务端零依赖，条目数有限（≤100 文件），体积换简单性。 */
export function buildZipStored(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const { time, date } = dosDateTime(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags
    lh.writeUInt16LE(0, 8);             // method: stored
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0, 8);             // flags
    ch.writeUInt16LE(0, 10);            // method: stored
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);       // local header offset
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** 打包资产为 zip（文件 + manifest.json + README.md），供下载路由。 */
export async function buildAssetZip(id: number): Promise<Buffer> {
  const asset = await getAssetOr404(id);
  if (asset.kind === 'onebox_link') throw httpError(400, 'OneBox 链接资产无本地文件可下载（请直接访问链接）。');
  const files = await getDb().prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ?').all<ScenarioAssetFileRow>(asset.id);
  if (files.length === 0) throw httpError(409, '资产尚未上传文件，无可下载内容。');
  const dir = assetAbsDir(asset);
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (const f of files) {
    const abs = path.join(dir, ...f.rel_path.split('/'));
    if (!fs.existsSync(abs)) throw httpError(409, `文件缺失：${f.rel_path}`);
    entries.push({ name: f.rel_path, data: fs.readFileSync(abs) });
  }
  for (const gen of ['manifest.json', 'README.md']) {
    const abs = path.join(dir, gen);
    if (fs.existsSync(abs)) entries.push({ name: gen, data: fs.readFileSync(abs) });
  }
  return buildZipStored(entries);
}

// ---------- 应用到目录（复制式，供运行副本机制 / 校验用） ----------

/**
 * 把资产文件复制到目标目录（不改基线，§8.4 copy 语义）。
 * 逐文件校验 sha256 后复制；任何缺失/漂移直接抛错 —— 调用方必须把失败显式标记为"资源未应用"。
 */
export async function applyAssetToDir(assetId: number, destDir: string): Promise<{
  assetNo: string; version: string; sha256: string; copied: Array<{ path: string; sha256: string }>;
}> {
  const asset = await getAssetOr404(assetId);
  if (asset.status === 'deprecated') throw httpError(409, '资产已下架，不能应用。');
  if (asset.kind === 'onebox_link') {
    // OneBox 不复制内容（§8.4）：返回链接记录，由调用方写入运行上下文
    return { assetNo: asset.asset_no, version: asset.version, sha256: asset.sha256, copied: [] };
  }
  const files = await getDb().prepare('SELECT * FROM scenario_asset_files WHERE asset_id = ?').all<ScenarioAssetFileRow>(asset.id);
  if (files.length === 0) throw httpError(409, '资产没有任何文件，无法应用。');
  const srcDir = assetAbsDir(asset);
  const copied: Array<{ path: string; sha256: string }> = [];
  for (const f of files) {
    const src = path.join(srcDir, ...f.rel_path.split('/'));
    if (!fs.existsSync(src)) throw httpError(409, `资源未应用：文件缺失 ${f.rel_path}（资产 ${asset.asset_no}）。`);
    const disk = fs.readFileSync(src);
    if (sha256Hex(disk) !== f.sha256) throw httpError(409, `资源未应用：sha256 漂移 ${f.rel_path}（资产 ${asset.asset_no}）。`);
    const dest = path.join(destDir, ...f.rel_path.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, disk);
    copied.push({ path: f.rel_path, sha256: f.sha256 });
  }
  return { assetNo: asset.asset_no, version: asset.version, sha256: asset.sha256, copied };
}
