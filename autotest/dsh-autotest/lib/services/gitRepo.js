// 真实 git 集成：pull_repo / update_repo 任务执行（替代原模拟占位）
// 依赖系统 git CLI；仓库根目录 = 配置 app.workspace/repos/<lib>，
// 每库在 libraries.last_commit 记录上次同步提交，用于拉取后的变更文件解析。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';
const execFileAsync = promisify(execFile);
/** 工作区根目录（app.workspace 配置；未配置时落到插件进程 cwd/workspace）。 */
export function workspaceDir() {
    const base = String(getSetting('app.workspace', '') || '').trim();
    const dir = base || path.join(process.cwd(), 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
/** 仓库本地目录（工作区 repos/<name>）。 */
export function repoDirFor(name) {
    return path.join(workspaceDir(), 'repos', repoName(name));
}
function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
function deriveName(url) {
    const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
    const seg = cleaned.split(/[/\\]/).filter(Boolean).pop() ?? '';
    const base = (seg || `repo-${hashCode(url) % 100000}`).replace(/[^\w.-]/g, '_');
    return base || 'repo';
}
/** 按仓库地址解析三方库：已存在（repo_url 匹配）则复用，否则自动创建。 */
export function ensureLibraryByRepoUrl(url) {
    const db = getDb();
    const t = now();
    const trimmed = url.trim();
    const existing = db.prepare('SELECT * FROM libraries WHERE repo_url = ?').get(trimmed);
    if (existing)
        return existing;
    let name = deriveName(trimmed);
    let n = 1;
    while (db.prepare('SELECT id FROM libraries WHERE name = ?').get(name)) {
        name = `${deriveName(trimmed)}-${++n}`;
    }
    db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES (?, ?, '由任务创建（拉取仓库代码）', 'v0.0.0', 'active', ?, ?)`).run(name, trimmed, t, t);
    return db.prepare('SELECT * FROM libraries WHERE id = last_insert_rowid()').get();
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
function saveSync(libId, commit, version) {
    const db = getDb();
    const t = now();
    db.prepare(`UPDATE libraries SET current_version = ?, last_commit = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`)
        .run(version, commit, t, t, libId);
}
/** 拉取仓库：目录不存在则 clone，否则 pull；返回提交、分支、变更文件与版本。 */
export async function pullRepo(lib) {
    if (!lib.repo_url) {
        throw new Error('该三方库未配置仓库地址（repo_url 为空），请先在用例库中补充仓库 URL 后再拉取。');
    }
    const dir = path.join(workspaceDir(), 'repos', repoName(lib.name));
    const prev = lib.last_commit || '';
    let action;
    if (fs.existsSync(path.join(dir, '.git'))) {
        await runGit(['pull', '--ff-only'], dir);
        action = 'pull';
    }
    else {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await runGit(['clone', lib.repo_url, dir]);
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
    saveSync(lib.id, commit, version);
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
