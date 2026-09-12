// 三方库测试表（xlsx）→ 业务库（db）同步。
//
// 分工是刻意的（需求原话）：
//   xlsx —— 人维护：**有哪些库**、**每个库对应哪个仓库/子目录**。
//   db   —— Agent 维护：包名、入口 Ability、最近同步提交、版本、状态等"运行时事实"。
//
// 因此同步是**单向**的（xlsx → db），且只写「人维护的那两列」，绝不覆盖 Agent 字段：
//   - 不会写：package_name / main_ability / last_commit / current_version / last_synced_at / status
//   - 不会删：库里有、表里没有的行只做**报告**，交由人决定（删库会级联删用例与执行历史）
// 这条边界是整个功能的关键：一旦同步顺手覆盖包名，真机遍历好不容易补齐的信息就没了。
import fs from 'node:fs';
import path from 'node:path';
// xlsx（SheetJS）是 CJS 包：必须用**默认导入**。
// `import * as XLSX from 'xlsx'` 在本工程的 ESM 产物里拿到的是命名空间对象，
// 运行期 `XLSX.readFile is not a function`（实测踩过），而 http.ts 里一直是默认导入所以没暴露。
import XLSX from 'xlsx';
import { getDb, now } from '../db/connection.js';
import { dataDir } from '../db/sqlite.js';
import { normalizeRepoUrl, splitRepoUrl } from './gitRepo.js';
import { getSetting } from './settings.js';
// ---------- 纯函数区（离线自检覆盖） ----------
const NAME_HEADERS = ['三方库名称', '库名', '库名称', '名称', '三方库', 'name', 'library'];
const URL_HEADERS = ['url', '仓库地址', '仓库url', '仓库', 'git地址', 'repo', 'repository'];
function cellText(v) {
    if (v === null || v === undefined)
        return '';
    return String(v).replace(/^\uFEFF/, '').trim();
}
/**
 * 定位表头行与列。人的表会加标题行、调列序，所以按**表头名**找而不是写死 A/B，
 * 找不到表头时退回「第一行是表头、前两列分别是库名与 URL」这个最常见的排布。
 */
export function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const cells = (rows[i] ?? []).map((c) => cellText(c).toLowerCase());
        const nameCol = cells.findIndex((c) => NAME_HEADERS.includes(c));
        const urlCol = cells.findIndex((c) => URL_HEADERS.includes(c));
        if (nameCol >= 0 && urlCol >= 0 && nameCol !== urlCol)
            return { row: i + 1, nameCol, urlCol };
    }
    return null;
}
/**
 * 把表格二维数组解析成库清单。
 * 会跳过的行都进 problems（带行号），不做静默丢弃 —— 269 行里少一行必须看得见。
 */
export function parseLibrarySheet(rows) {
    const problems = [];
    const entries = [];
    const header = findHeader(rows) ?? { row: 1, nameCol: 0, urlCol: 1 };
    const seen = new Map();
    for (let i = header.row; i < rows.length; i++) {
        const raw = rows[i] ?? [];
        const rowNo = i + 1;
        const name = cellText(raw[header.nameCol]);
        const url = cellText(raw[header.urlCol]);
        if (!name && !url)
            continue; // 完全空行：忽略
        if (!name) {
            problems.push({ row: rowNo, name: '', reason: `整行缺少库名（URL=${url || '空'}），已跳过` });
            continue;
        }
        if (name.length > 128) {
            problems.push({ row: rowNo, name: name.slice(0, 40), reason: `库名过长（${name.length} 字符 > 128），已跳过` });
            continue;
        }
        const first = seen.get(name);
        if (first !== undefined) {
            problems.push({ row: rowNo, name, reason: `库名重复（第 ${first} 行已出现过），本行已跳过` });
            continue;
        }
        if (!url) {
            problems.push({ row: rowNo, name, reason: '缺少仓库地址，已跳过（可先建库后人工补地址）' });
            continue;
        }
        if (!/^https?:\/\//i.test(url)) {
            problems.push({ row: rowNo, name, reason: `仓库地址不是 http(s) 链接：${url}，已跳过` });
            continue;
        }
        const { repoUrl, subpath } = splitRepoUrl(url);
        if (!repoUrl) {
            problems.push({ row: rowNo, name, reason: `无法解析仓库地址：${url}，已跳过` });
            continue;
        }
        seen.set(name, rowNo);
        entries.push({ row: rowNo, name, repoUrl, repoSubpath: subpath });
    }
    return { entries, problems, header };
}
/** 计算同步计划（纯函数：给同一份表与库表，结果永远一致，便于预览与实际执行对齐）。 */
export function diffLibrarySheet(entries, existing, problems = []) {
    const byName = new Map(existing.map((l) => [l.name, l]));
    const plan = { added: [], updated: [], unchanged: [], dbOnly: [], problems: [...problems] };
    const matched = new Set();
    for (const e of entries) {
        const cur = byName.get(e.name);
        if (!cur) {
            plan.added.push({ name: e.name, repoUrl: e.repoUrl, repoSubpath: e.repoSubpath, row: e.row });
            continue;
        }
        matched.add(cur.id);
        // 只比较「人维护的两列」。注意历史行可能存着带 /tree/... 的原始地址，
        // 比较前统一归一化，否则会被判成"每次都变了"而反复写入。
        const curUrl = normalizeRepoUrl(cur.repo_url);
        const curSub = String(cur.repo_subpath ?? '');
        if (curUrl !== e.repoUrl || curSub !== e.repoSubpath) {
            plan.updated.push({
                id: cur.id, name: cur.name, row: e.row,
                from: { repoUrl: cur.repo_url, repoSubpath: curSub },
                to: { repoUrl: e.repoUrl, repoSubpath: e.repoSubpath },
            });
        }
        else {
            plan.unchanged.push({ id: cur.id, name: cur.name, row: e.row });
        }
    }
    for (const l of existing) {
        if (matched.has(l.id))
            continue;
        plan.dbOnly.push({
            id: l.id, name: l.name, repoUrl: l.repo_url, repoSubpath: String(l.repo_subpath ?? ''),
            packageName: String(l.package_name ?? ''), caseCount: l.case_count ?? 0,
        });
    }
    plan.dbOnly.sort((a, b) => a.id - b.id);
    return plan;
}
// ---------- IO 区 ----------
/**
 * 表文件路径解析：**显式指定的路径优先且不兜底**。
 *
 * 「指定了文件但文件不在」必须报错，不能悄悄换一个文件去同步 ——
 * 否则人会以为同步的是自己刚改的那份表，实际同步的是另一个目录里的旧文件，
 * 269 个库整批写错却毫无提示（这个坑自检里已经踩到过一次）。
 */
export function resolveSheetPath(explicit) {
    const configured = String(explicit ?? getSetting('libraries.xlsxPath', '') ?? '').trim();
    if (configured) {
        const file = path.isAbsolute(configured) ? configured : path.resolve(dataDir(), '..', configured);
        return { file, exists: fs.existsSync(file), tried: [file] };
    }
    const candidates = [
        path.join(dataDir(), '三方库测试表.xlsx'),
        path.join(dataDir(), 'libraries.xlsx'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c))
            return { file: c, exists: true, tried: candidates };
    }
    return { file: candidates[0], exists: false, tried: candidates };
}
/** 读取 xlsx 并解析出库清单（不含 DB 交互）。 */
export function readSheet(file) {
    if (!fs.existsSync(file)) {
        throw Object.assign(new Error(`找不到三方库测试表：${file}。请在「系统配置」里设置 libraries.xlsxPath，或把表放到该路径。`), { statusCode: 400 });
    }
    const wb = XLSX.readFile(file);
    const sheetName = wb.SheetNames[0];
    const ws = sheetName ? wb.Sheets[sheetName] : undefined;
    if (!ws)
        throw Object.assign(new Error(`表里没有任何工作表：${file}`), { statusCode: 400 });
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    const parsed = parseLibrarySheet(rows);
    if (parsed.entries.length === 0) {
        throw Object.assign(new Error(`表里没有解析出任何库（工作表 ${sheetName}，共 ${rows.length} 行）。请确认表头含「三方库名称」与「URL」两列。`), { statusCode: 400 });
    }
    return { ...parsed, file };
}
/** 读出库表现状（含用例数），供 diff 使用。 */
async function loadExisting() {
    return await getDb().prepare(`SELECT l.id, l.name, l.repo_url, l.repo_subpath, l.package_name,
            (SELECT COUNT(*) FROM cases c WHERE c.library_id = l.id) AS case_count
     FROM libraries l ORDER BY l.id`).all();
}
/**
 * 同步：读表 → 与库表比对 → （可选）落库。
 * apply=false 时只返回计划（预览），不写任何数据 —— 269 行的批量写入必须先让人看过。
 */
export async function syncLibrariesFromSheet(opts = {}) {
    const { file } = resolveSheetPath(opts.file);
    const parsed = readSheet(file);
    const plan = diffLibrarySheet(parsed.entries, await loadExisting(), parsed.problems);
    const apply = opts.apply === true;
    if (!apply)
        return { file, total: parsed.entries.length, plan, applied: false, header: parsed.header };
    const db = getDb();
    const t = now();
    await db.transaction(async () => {
        for (const a of plan.added) {
            await db.prepare(`INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, status, created_at, updated_at)
        VALUES (?, ?, ?, '来自三方库测试表.xlsx', 'v0.0.0', 'active', ?, ?)`)
                .run(a.name, a.repoUrl, a.repoSubpath, t, t);
        }
        for (const u of plan.updated) {
            // 只改「人维护的两列」：包名/入口 Ability/同步状态一律不动
            await db.prepare('UPDATE libraries SET repo_url = ?, repo_subpath = ?, updated_at = ? WHERE id = ?')
                .run(u.to.repoUrl, u.to.repoSubpath, t, u.id);
        }
    });
    return { file, total: parsed.entries.length, plan, applied: true, header: parsed.header };
}
/**
 * 反向导出：把「库里的事实」写成一份**新文件**，供人查看 Agent 补了什么。
 * 绝不写回人维护的那份表 —— xlsx 是人的东西，工具不去改它。
 */
export async function exportLibrariesSheet(outFile) {
    const rows = await getDb().prepare(`SELECT l.name, l.repo_url, l.repo_subpath, l.package_name, l.main_ability, l.status,
            l.current_version, l.last_synced_at, l.last_commit,
            (SELECT COUNT(*) FROM cases c WHERE c.library_id = l.id) AS case_count
     FROM libraries l ORDER BY l.name`).all();
    const header = ['三方库名称', 'URL', '仓库内子目录', '包名(bundleName)', '入口Ability', '状态', '版本', '最近同步', '最近提交', '用例数'];
    const data = rows.map((r) => [
        r.name, r.repo_url, r.repo_subpath ?? '', r.package_name ?? '', r.main_ability ?? '',
        r.status ?? '', r.current_version ?? '', r.last_synced_at ?? '', String(r.last_commit ?? '').slice(0, 8),
        Number(r.case_count ?? 0),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...data]), '库状态');
    const file = outFile && path.isAbsolute(outFile) ? outFile : path.join(dataDir(), outFile || '三方库测试表.库状态回写.xlsx');
    XLSX.writeFile(wb, file);
    return { file, rows: data.length };
}
