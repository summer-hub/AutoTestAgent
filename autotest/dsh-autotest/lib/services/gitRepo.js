// 真实 git 集成：pull_repo / update_repo 任务执行（替代原模拟占位）
// 依赖系统 git CLI；仓库根目录 = 配置 app.workspace/repos/<lib>，
// 每库在 libraries.last_commit 记录上次同步提交，用于拉取后的变更文件解析。
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';
const execFileAsync = promisify(execFile);
/** 工作区根目录：app.workspace 显式设置优先；未设置时回退到启动目录下的 workspace（并在使用处提示）。 */
export function workspaceDir() {
    const base = String(getSetting('app.workspace', '') || '').trim();
    const dir = base || path.join(process.cwd(), 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/** 工作区是否已在系统配置中显式设置。 */
export function workspaceConfigured() {
    return !!String(getSetting('app.workspace', '') || '').trim();
}
/** 未配置工作区时的提示语（配置了返回 null）。 */
export function workspaceNotice() {
    if (workspaceConfigured())
        return null;
    return `⚠️ 未在「系统配置」中设置工作区路径，本次已临时使用启动目录下的 workspace：${workspaceDir()}。建议设置固定路径，避免更换启动目录后仓库/脚本/遍历报告分散丢失。`;
}
/** 运行中对账：仓库目录被删除时清空库的同步状态（首页/用例页不再残留过期信息）。 */
export async function reconcileRepos() {
    const db = getDb();
    const libs = await db.prepare('SELECT id, name FROM libraries').all();
    let changed = 0;
    for (const l of libs) {
        const hasRepo = fs.existsSync(`${repoDirFor(l.name)}/.git`);
        const row = await db.prepare('SELECT last_commit, last_synced_at, package_name FROM libraries WHERE id = ?')
            .get(l.id);
        if (!row)
            continue;
        if (!hasRepo && (row.last_commit || row.last_synced_at)) {
            await db.prepare(`UPDATE libraries SET last_commit = '', last_synced_at = NULL, updated_at = ? WHERE id = ?`)
                .run(now(), l.id);
            changed++;
        }
        else if (hasRepo && !row.package_name) {
            try {
                await refreshPackageInfo({ id: l.id, name: l.name });
            }
            catch { /* 忽略 */ }
        }
    }
    return changed;
}
async function runGit(args, cwd, timeoutMs = 180000) {
    const { stdout } = await execFileAsync('git', args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
        windowsHide: true,
    });
    return stdout.trim();
}
function repoName(name) {
    return name.replace(/[^\w.-]/g, '_');
}
/** 解析已克隆仓库工程：bundleName / mainAbility / 页面列表 / 入口页代码（供 AI 设计真实 UI 用例）。 */
export function inspectRepo(lib) {
    const dir = path.join(workspaceDir(), 'repos', repoName(lib.name));
    const result = { dir, bundleName: '', abilityName: '', pages: [], entryDemo: '' };
    if (!fs.existsSync(path.join(dir, '.git')))
        return result;
    const candidates = [
        'AppScope/app.json5', 'AppScope/app.json',
        'entry/src/main/module.json5', 'entry/src/main/module.json',
    ];
    for (const rel of candidates) {
        const file = path.join(dir, rel);
        if (!fs.existsSync(file))
            continue;
        try {
            const txt = fs.readFileSync(file, 'utf8');
            const bn = txt.match(/["']?bundleName["']?\s*[:=]\s*["']([^"']+)/);
            if (bn)
                result.bundleName = bn[1];
            const ab = txt.match(/(?:["']?mainAbility["']?|["']?abilityName["']?|["']?mainElement["']?)\s*[:=]\s*["']([^"']+)/);
            if (ab)
                result.abilityName = ab[1];
            if (result.bundleName && result.abilityName)
                break;
        }
        catch { /* 忽略不可读文件 */ }
    }
    const pagesRoot = path.join(dir, 'entry', 'src', 'main', 'ets', 'pages');
    if (fs.existsSync(pagesRoot)) {
        result.pages = fs.readdirSync(pagesRoot).filter((f) => f.endsWith('.ets')).sort();
    }
    if (result.pages.length > 0) {
        try {
            result.entryDemo = fs.readFileSync(path.join(pagesRoot, result.pages[0]), 'utf8').slice(0, 8000);
        }
        catch { /* 忽略 */ }
    }
    return result;
}
/** 最近一次同步以来的仓库变更文件列表（用于用例更新上下文）。 */
export function recentChanges(lib) {
    const dir = path.join(workspaceDir(), 'repos', repoName(lib.name));
    if (!fs.existsSync(path.join(dir, '.git')))
        return [];
    try {
        const head = runGitSync(['rev-parse', 'HEAD'], dir);
        if (lib.last_commit && lib.last_commit !== head) {
            return runGitSync(['diff', '--name-only', lib.last_commit, head], dir).split(/\r?\n/).filter(Boolean);
        }
        return runGitSync(['show', '--name-only', '--format=', 'HEAD'], dir).split(/\r?\n/).filter(Boolean);
    }
    catch {
        return [];
    }
}
function runGitSync(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
}
/** 仓库本地目录（工作区 repos/<name>）。 */
export function repoDirFor(name) {
    return path.join(workspaceDir(), 'repos', repoName(name));
}
/** 自动化脚本落盘目录（工作区 scripts/<name>）。 */
export function scriptsDirFor(name) {
    return path.join(workspaceDir(), 'scripts', repoName(name));
}
function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
/**
 * 仓库 URL 规范化：剥离网页浏览路径段，得到可 clone 的仓库根地址。
 *  - `https://host/owner/repo/tree/master/subdir` → `https://host/owner/repo.git`
 *  - `https://host/owner/repo/blob/master/file.md` → `https://host/owner/repo.git`
 *  - 仅对 gitcode/github/gitee/gitlab 等平台补 `.git`（ssh/本地路径不补）
 */
export function normalizeRepoUrl(url) {
    let u = String(url || '').trim();
    if (!u)
        return '';
    u = u.replace(/\/tree\/[^/]+(?:\/[^?#]*)?$/, '');
    u = u.replace(/\/blob\/[^/]+(?:\/[^?#]*)?$/, '');
    u = u.replace(/[?#].*$/, '');
    u = u.replace(/\/+$/, '');
    if (!/\.git$/.test(u) && /(?:gitcode\.com|github\.com|gitee\.com|gitlab\.com)/i.test(u)) {
        u = `${u}.git`;
    }
    return u;
}
function deriveName(url) {
    const cleaned = normalizeRepoUrl(url).replace(/\.git$/, '');
    const seg = cleaned.split(/[/\\]/).filter(Boolean).pop() ?? '';
    const base = (seg || `repo-${hashCode(url) % 100000}`).replace(/[^\w.-]/g, '_');
    return base || 'repo';
}
/** 按仓库地址解析三方库：已存在（repo_url 匹配）则复用，否则自动创建。 */
export async function ensureLibraryByRepoUrl(url) {
    const db = getDb();
    const t = now();
    const trimmed = url.trim();
    const normalized = normalizeRepoUrl(trimmed) || trimmed;
    const existing = await db.prepare('SELECT * FROM libraries WHERE repo_url = ? OR repo_url = ?').get(normalized, trimmed);
    if (existing)
        return existing;
    let name = deriveName(normalized);
    let n = 1;
    while (await db.prepare('SELECT id FROM libraries WHERE name = ?').get(name)) {
        name = `${deriveName(normalized)}-${++n}`;
    }
    const res = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES (?, ?, '由任务创建（拉取仓库代码）', 'v0.0.0', 'active', ?, ?)`).run(name, normalized, t, t);
    return (await db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(res.lastInsertRowid)));
}
async function describeVersion(dir, fallback) {
    try {
        const tag = await runGit(['describe', '--tags', '--abbrev=0'], dir);
        return tag || fallback;
    }
    catch {
        try {
            const short = await runGit(['rev-parse', '--short', 'HEAD'], dir);
            return `dev-${short}`;
        }
        catch {
            return fallback;
        }
    }
}
async function saveSync(libId, commit, version) {
    const db = getDb();
    const t = now();
    await db.prepare(`UPDATE libraries SET current_version = ?, last_commit = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`)
        .run(version, commit, t, t, libId);
}
/** 解析仓库包名/主 Ability（app.json5 / module.json5）并回填 libraries 表。 */
export async function refreshPackageInfo(lib) {
    const insp = inspectRepo(lib);
    const packageName = insp.bundleName;
    const mainAbility = insp.abilityName;
    if (packageName) {
        try {
            await getDb().prepare(`UPDATE libraries SET package_name = ?, main_ability = ?, updated_at = ? WHERE id = ?`)
                .run(packageName, mainAbility, now(), lib.id);
        }
        catch (e) {
            console.warn(`[autotest] 回填包名失败（${lib.name}）：`, e.message);
        }
    }
    return { packageName, mainAbility };
}
/** 拉取仓库：目录不存在则 clone，否则 pull；返回提交、分支、变更文件与版本。 */
export async function pullRepo(lib) {
    if (!lib.repo_url) {
        throw new Error('该三方库未配置仓库地址（repo_url 为空），请先在用例库中补充仓库 URL 后再拉取。');
    }
    const dir = path.join(workspaceDir(), 'repos', repoName(lib.name));
    const prev = lib.last_commit || '';
    let action;
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) {
        // 已有仓库 → 进入该目录 git pull
        await runGit(['pull', '--ff-only'], dir);
        action = 'pull';
    }
    else {
        // 无仓库 → git clone；目录已存在但不是 git 仓库时给出明确错误
        if (fs.existsSync(dir)) {
            const leftovers = fs.readdirSync(dir).filter((n) => n !== '.git');
            if (leftovers.length > 0) {
                throw new Error(`本地目录已存在但不是 git 仓库（${dir}），请先清理该目录或更换工作区后再拉取。`);
            }
        }
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await runGit(['clone', normalizeRepoUrl(lib.repo_url) || lib.repo_url, dir]);
        action = 'clone';
    }
    const commit = await runGit(['rev-parse', 'HEAD'], dir);
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    let changedFiles = [];
    if (action === 'pull' && prev && prev !== commit) {
        changedFiles = (await runGit(['diff', '--name-only', prev, commit], dir)).split(/\r?\n/).filter(Boolean);
    }
    else if (action === 'clone' || !prev) {
        changedFiles = (await runGit(['show', '--name-only', '--format=', 'HEAD'], dir)).split(/\r?\n/).filter(Boolean);
    }
    const version = await describeVersion(dir, lib.current_version);
    await saveSync(lib.id, commit, version);
    // 拉取后解析包名/主 Ability 入库（供真机启动/遍历/首页展示）
    await refreshPackageInfo(lib);
    const changedCount = changedFiles.length;
    const summary = action === 'clone'
        ? `已克隆 ${lib.name}（${branch} @ ${commit.slice(0, 8)}），当前版本 ${version}，最近提交含 ${changedCount} 个变更文件。`
        : `已更新 ${lib.name}（${branch} @ ${commit.slice(0, 8)}），当前版本 ${version}${prev && prev !== commit ? `，自上次同步新增/变更 ${changedCount} 个文件` : '，无新变更'}。`;
    return { action, dir, branch, commit, changedFiles, changedCount, version, summary };
}
/** 更新仓库 = 拉取 + 变更文件明细。 */
export async function updateRepo(lib) {
    const r = await pullRepo(lib);
    const detail = r.changedFiles.length > 0 ? `\n变更文件（前 20）：${r.changedFiles.slice(0, 20).join(', ')}` : '';
    r.summary = `【更新仓库】${r.summary}${detail}`;
    return r;
}
