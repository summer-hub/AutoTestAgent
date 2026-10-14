// R0：目录引导（catalog bootstrap）—— 让「三方库测试表.xlsx」第一次启动就进库。
//
// 定位（需求原话 + 重构方案 §4.1）：
//   xlsx 是**随包的初始种子 + 人工增量入口**；SQLite/MySQL 业务库是**唯一事实源**。
//   首次导入之后，平台一律以业务库为准；这份表不再被回写（librarySheet.ts 的单向边界保留）。
//
// 为什么必须有这一步（重构方案 §1.1 的三层脱节）：
//   ① 分发层——仓库根 data/ 不在安装产物里（package.json 的 files 只有 lib）；
//   ② 路径层——resolveSheetPath() 只认数据目录，没有"随包默认表"的概念；
//   ③ 触发层——同步是手动 API，启动时没人调用。
// 三个入口（DSH 插件 / 独立 server / 桌面端）共用同一个 dataDir()，所以在这里补一次即可全覆盖。
//
// 三条纪律（与 db/sqlite.ts 的 adoptLegacyData 同源）：
//   1. 绝不因为 bootstrap 失败就拿空库启动——表读不出来只告警，不抛异常阻断启动；
//   2. 绝不覆盖 Agent 字段——导入复用 syncLibrariesFromSheet()，它只写"人维护的两列"；
//   3. 幂等——diff 出 added/updated 都是空就不再写库，也不留导入记录（不刷历史）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb, now } from '../db/connection.js';
import { dataDir } from '../db/sqlite.js';
import { getSetting } from './settings.js';
import { resolveSheetPath, syncLibrariesFromSheet, type SheetProblem } from './librarySheet.js';

/** 随包资产里的表名（与 assets/ 下的文件逐一对应）。 */
const BUNDLED_SHEET = '三方库测试表.xlsx';

/** 插件包根目录：本文件位于 <包根>/lib/services（或 src/services）下。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 随包资产的候选路径。构建后是 lib/assets/（tsc 只编译 src，assets 由
 * scripts/build-assets.mjs 复制进去）；tsx 直接跑 src/ 时退回 <包根>/assets/。
 */
function bundledCandidates(): string[] {
  return [
    path.join(PACKAGE_ROOT, 'lib', 'assets', BUNDLED_SHEET),
    path.join(PACKAGE_ROOT, 'assets', BUNDLED_SHEET),
  ];
}

/** 定位随包表（不存在返回 null，调用方据此降级为"无种子"）。 */
export function bundledSheet(): { path: string; sha256: string } | null {
  for (const p of bundledCandidates()) {
    if (fs.existsSync(p)) return { path: p, sha256: fileSha256(p) };
  }
  return null;
}

function fileSha256(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

export interface CatalogRunResult {
  status: 'imported' | 'unchanged' | 'missing';
  /** 实际使用的那份表（数据目录里的路径优先，随包种子回填后也是它） */
  file: string;
  source: 'bundled' | 'data-dir' | 'configured';
  sha256: string;
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  dbOnly: number;
  problems: SheetProblem[];
  /** 导入了但有问题行时的提示（启动日志用） */
  note: string;
}

/**
 * 把随包种子回填到数据目录（仅当数据目录里没有表、且用户没有显式指定别的表时）。
 *
 * 「显式指定了文件但文件不在」必须报错、不能悄悄换一份——这是 librarySheet.ts
 * resolveSheetPath() 已经守住的边界，这里同样遵守：有配置就不回填。
 */
function seedDataDirSheet(): { file: string; from: string } | null {
  const configured = String(getSetting('libraries.xlsxPath', '') ?? '').trim();
  if (configured) return null; // 人指定了别的表：不插手
  const target = path.join(dataDir(), BUNDLED_SHEET);
  if (fs.existsSync(target)) return null;
  const bundled = bundledSheet();
  if (!bundled) return null;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.copyFileSync(bundled.path, target);
    return { file: target, from: bundled.path };
  } catch (e) {
    console.warn(`[autotest] 随包三方库测试表回填数据目录失败（${(e as Error).message}），本次不导入`);
    return null;
  }
}

/**
 * 启动 bootstrap：确保目录表已进业务库。**永不抛异常**——启动路径上任何失败都只能是告警。
 *
 * 幂等：同一份表（sha256 相同）且 diff 无变化时不写库、不留导入记录。
 */
export async function ensureLibraryCatalog(): Promise<CatalogRunResult> {
  const empty: CatalogRunResult = {
    status: 'missing', file: '', source: 'bundled', sha256: '', total: 0,
    added: 0, updated: 0, unchanged: 0, dbOnly: 0, problems: [], note: '',
  };
  try {
    seedDataDirSheet();
    const resolved = resolveSheetPath();
    if (!resolved.exists) {
      const note = '数据目录里没有三方库测试表，且随包资产缺失——库清单保持原样（可人工放置表或设置 libraries.xlsxPath）';
      console.warn(`[autotest] 目录引导跳过：${note}`);
      return { ...empty, note };
    }
    const source: CatalogRunResult['source'] = resolved.file === path.join(dataDir(), BUNDLED_SHEET)
      ? (bundledSheet() ? 'bundled' : 'data-dir')
      : 'data-dir';

    // 复用 librarySheet.ts 的既有链路（readSheet → diff → apply）：
    // 它只写「人维护的两列」，绝不覆盖 package_name / main_ability / last_commit 等 Agent 字段。
    const r = await syncLibrariesFromSheet({ file: resolved.file, apply: true });
    const plan = r.plan;
    const changed = plan.added.length > 0 || plan.updated.length > 0;

    if (changed) {
      await recordImport({
        source: source === 'bundled' ? 'bundled' : 'manual',
        file: resolved.file, sha256: fileSha256(resolved.file),
        total: r.total, plan, applied: true,
      });
    }

    const note = changed
      ? `目录引导：新增 ${plan.added.length} / 更新 ${plan.updated.length} / 无变化 ${plan.unchanged.length} / 仅库中存在 ${plan.dbOnly.length}`
      : `目录引导：无变化（${plan.unchanged.length} 个库已与表一致）`;
    console.log(`[autotest] ${note}${plan.problems.length ? `，${plan.problems.length} 行有问题（见 /libraries/catalog）` : ''}`);

    return {
      status: changed ? 'imported' : 'unchanged',
      file: resolved.file, source, sha256: fileSha256(resolved.file),
      total: r.total, added: plan.added.length, updated: plan.updated.length,
      unchanged: plan.unchanged.length, dbOnly: plan.dbOnly.length,
      problems: plan.problems, note,
    };
  } catch (e) {
    // 启动路径：绝不因为表读不了就让插件起不来。
    const note = `目录引导失败（不影响启动）：${(e as Error).message}`;
    console.warn(`[autotest] ${note}`);
    return { ...empty, note };
  }
}

/** 写一条导入留痕（只追加，不更新——人改表后重新导入就是新的一条）。 */
async function recordImport(row: {
  source: string; file: string; sha256: string; total: number;
  plan: { added: unknown[]; updated: unknown[]; unchanged: unknown[]; dbOnly: unknown[]; problems: SheetProblem[] };
  applied: boolean;
}): Promise<void> {
  try {
    await getDb().prepare(`INSERT INTO library_catalog_imports
      (source, file_path, file_sha256, total, added, updated, unchanged, db_only, problems, problems_json, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.source, row.file, row.sha256, row.total,
        row.plan.added.length, row.plan.updated.length, row.plan.unchanged.length,
        row.plan.dbOnly.length, row.plan.problems.length,
        JSON.stringify(row.plan.problems), row.applied ? 1 : 0, now());
  } catch (e) {
    console.warn(`[autotest] 目录引导导入留痕写入失败（不影响导入本身）：${(e as Error).message}`);
  }
}

export interface CatalogStatus {
  bundled: { exists: boolean; path: string; sha256: string } | null;
  /** 数据目录里实际在用的那份表 */
  active: { file: string; exists: boolean; configured: string };
  latest: {
    at: string; source: string; sha256: string; total: number;
    added: number; updated: number; unchanged: number; dbOnly: number; problems: number;
  } | null;
  problems: SheetProblem[];
  db: { libraries: number; profiled: number; unprofiled: number };
}

/**
 * 供前端/agent 查询的目录状态。`profiled` 在 R0 恒为 0（env_profiles 表 R1 才建），
 * 这里做成**表不存在时自动降级为 0**——R1 加上表后这个接口无需改代码就会亮。
 */
export async function catalogStatus(): Promise<CatalogStatus> {
  const db = getDb();
  const bundled = bundledSheet();
  const resolved = resolveSheetPath();
  const configured = String(getSetting('libraries.xlsxPath', '') ?? '').trim();

  const libRow = await db.prepare('SELECT COUNT(*) AS n FROM libraries').get<{ n: number }>();
  const libraries = Number(libRow?.n ?? 0);

  let profiled = 0;
  try {
    const row = await db.prepare('SELECT COUNT(DISTINCT library_id) AS n FROM env_profiles').get<{ n: number }>();
    profiled = Number(row?.n ?? 0);
  } catch { /* R1 之前没有这张表：降级为 0 */ }

  let latest: CatalogStatus['latest'] = null;
  let problems: SheetProblem[] = [];
  try {
    const row = await db.prepare(`SELECT * FROM library_catalog_imports ORDER BY id DESC LIMIT 1`)
      .get<Record<string, unknown>>();
    if (row) {
      latest = {
        at: String(row.created_at ?? ''), source: String(row.source ?? ''),
        sha256: String(row.file_sha256 ?? ''), total: Number(row.total ?? 0),
        added: Number(row.added ?? 0), updated: Number(row.updated ?? 0),
        unchanged: Number(row.unchanged ?? 0), dbOnly: Number(row.db_only ?? 0),
        problems: Number(row.problems ?? 0),
      };
      try { problems = JSON.parse(String(row.problems_json || '[]')) as SheetProblem[]; } catch { problems = []; }
    }
  } catch { /* 表还没建（理论上 ensureSchema 已建）：降级为无记录 */ }

  return {
    bundled: bundled ? { exists: true, path: bundled.path, sha256: bundled.sha256 } : { exists: false, path: '', sha256: '' },
    active: { file: resolved.file, exists: resolved.exists, configured },
    latest, problems,
    db: { libraries, profiled, unprofiled: Math.max(0, libraries - profiled) },
  };
}
