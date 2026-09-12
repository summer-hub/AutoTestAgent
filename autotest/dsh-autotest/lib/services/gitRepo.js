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
/**
 * 工作区根目录，优先级：`AUTOTEST_WORKSPACE` 环境变量 > 系统配置 `app.workspace` > 启动目录下的 workspace。
 *
 * 环境变量优先是给**自检与 CI** 用的（与 `AUTOTEST_DATA_DIR` 同一套约定）：
 * 自检必须能在临时目录里跑，绝不能碰使用者真实工作区里的仓库与知识库。
 */
export function workspaceDir() {
    const override = String(process.env.AUTOTEST_WORKSPACE || '').trim();
    if (override) {
        fs.mkdirSync(override, { recursive: true });
        return override;
    }
    const base = String(getSetting('app.workspace', '') || '').trim();
    const dir = base || path.join(process.cwd(), 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/** 工作区是否已在系统配置中显式设置。 */
export function workspaceConfigured() {
    return !!String(getSetting('app.workspace', '') || '').trim();
}
/**
 * 旧版本种子数据写死的开发机默认工作区。
 * 命中它说明这条配置来自种子、而非使用者显式设置 —— 需要提示，但不能替使用者改数据
 * （该目录下可能已经存在真实的 repos/ 与 hypium 工程，静默清空会让平台看起来"数据全没了"）。
 */
const LEGACY_SEEDED_WORKSPACE = 'D:\\autotest\\workspace';
/** 路径归一化比较：忽略分隔符差异与大小写（Windows 路径不区分大小写）。 */
function samePath(a, b) {
    const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return norm(a) === norm(b);
}
/** 未配置工作区（或配置来自旧种子默认值）时的提示语；正常配置返回 null。 */
export function workspaceNotice() {
    const configured = String(getSetting('app.workspace', '') || '').trim();
    if (configured && samePath(configured, LEGACY_SEEDED_WORKSPACE)) {
        return `⚠️ 当前工作区 ${configured} 来自旧版本种子数据的默认值，并非你显式设置。若它不是你要的目录，请在「系统配置 → 工作区」改成实际路径（该目录下已有的仓库/脚本不会自动搬迁）。`;
    }
    if (configured)
        return null;
    return `⚠️ 未在「系统配置」中设置工作区路径，本次已临时使用启动目录下的 workspace：${workspaceDir()}。建议设置固定路径，避免更换启动目录后仓库/脚本/遍历报告分散丢失。`;
}
/** 运行中对账：仓库目录被删除时清空库的同步状态（首页/用例页不再残留过期信息）。 */
export async function reconcileRepos() {
    const db = getDb();
    const libs = await db.prepare('SELECT id, name, repo_url, repo_subpath FROM libraries').all();
    let changed = 0;
    for (const l of libs) {
        // 判断依据必须是**仓库根**（克隆落在那里），不是库目录。
        // 库目录对单体仓子目录库来说是 `<仓库根>/<子目录>`，那里本来就没有 .git；
        // 旧写法还会顺带看子目录里有没有 AppScope，于是"子目录恰好不是完整 demo 工程"的库
        // 每次启动都会被判成"没克隆过"而清空 last_commit（这个 bug 真的踩到过）。
        const root = String(l.repo_url ?? '').trim()
            ? repoRootForLib(l)
            : path.join(workspaceDir(), 'repos', repoName(l.name));
        const hasRepo = fs.existsSync(path.join(root, '.git'));
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
                await refreshPackageInfo(l);
            }
            catch { /* 忽略 */ }
        }
    }
    return changed;
}
/**
 * 启动数据迁移：把历史库行里自带 `/tree/<分支>/<子目录>` 的仓库地址拆成
 * 「仓库根 URL + repo_subpath」两列。
 *
 * 不做这一步，单体仓子目录库（三方库表里占 171/269）会一直踩两个坑：
 * `inspectRepo` 只看仓库根 → 包名永远解析不到；克隆按库名落到 `repos/<库名>` → 同仓各存一份。
 * 只改写"确实能拆出子目录"的行，其余不动。
 */
export async function migrateRepoSubpaths() {
    const db = getDb();
    const rows = await db.prepare(`SELECT id, name, repo_url, repo_subpath FROM libraries WHERE repo_url LIKE '%/tree/%'`)
        .all();
    let changed = 0;
    for (const r of rows) {
        const { repoUrl, subpath } = splitRepoUrl(r.repo_url);
        if (!repoUrl || repoUrl === r.repo_url)
            continue; // 没拆出东西就不动
        const nextSub = String(r.repo_subpath || '').trim() || subpath;
        await db.prepare('UPDATE libraries SET repo_url = ?, repo_subpath = ?, updated_at = ? WHERE id = ?')
            .run(repoUrl, nextSub, now(), r.id);
        changed++;
        console.log(`[autotest] 仓库地址拆分 #${r.id} ${r.name}：${r.repo_url} → ${repoUrl} + 子目录 ${nextSub || '（空）'}`);
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
/**
 * 从仓库 URL 切出「仓库根 URL」与「库在仓库内的子目录」。
 *
 * 三方库表里大量出现单体仓子目录地址（`.../openharmony_tpc_samples/tree/master/json-schema`）。
 * 必须把这两件事拆开，否则：
 *   - 仓库会按**库名**克隆，168 个同仓的库各存一份 591MB（≈97GB）；
 *   - `inspectRepo` 只看仓库根，子目录库永远解析不到 bundleName（实测 json-schema 包名一直为空）；
 *   - 用单体仓根目录当"库目录"，接口提取会把 250 个样本的导出符号混成同一个库的接口面。
 */
export function splitRepoUrl(url) {
    const raw = String(url || '').trim();
    const m = /^(.*?)\/tree\/([^/]+)(?:\/(.*?))?\/?$/.exec(raw);
    const repoUrl = normalizeRepoUrl(raw);
    if (!m)
        return { repoUrl, subpath: '', branch: '' };
    const rawSub = decodeURIComponent(String(m[3] ?? '').trim());
    return { repoUrl, subpath: normalizeSubpath(rawSub), branch: m[2] };
}
/**
 * 子目录安全归一化：先解一层 URL 编码，再去掉盘符/前导分隔符，并逐段剔除 `..`。
 *
 * 这里是**目录穿越的防线**：库目录 = 仓库根 + 本函数结果，一旦 `..` 漏过去就能读写工作区外的文件。
 * 先解码是必要的：地址里可能写成 `..%2F..%2Fsecret`，若不解码就变成一个看似普通的目录名，
 * 而同一路径从「URL」与从「显式字段」进来会得到两个不同的库目录（同一子目录被克隆两次）。
 */
export function normalizeSubpath(sub) {
    let s = String(sub || '');
    try {
        s = decodeURIComponent(s);
    }
    catch { /* 非法百分号序列：按原样处理，不做部分解码 */ }
    const parts = s
        .replace(/\\/g, '/')
        .split('/')
        .map((x) => x.trim())
        .filter((x) => x && x !== '.' && x !== '..');
    return parts.join('/');
}
/** 仓库检出目录：按**仓库名**共享（同仓的多个库只有一份克隆）。 */
export function repoRootDir(repoUrl) {
    const { repoUrl: root } = splitRepoUrl(repoUrl);
    const name = repoName(root ? deriveName(root) : `repo-${hashCode(repoUrl) % 100000}`);
    return path.join(workspaceDir(), 'repos', name || 'repo');
}
/** 同名不同组织的仓库撞车时用的备用目录（避免把两个不相干的仓库混成一个）。 */
function repoRootDirOwnered(repoUrl) {
    const { repoUrl: root } = splitRepoUrl(repoUrl);
    const seg = root.replace(/\.git$/, '').split(/[/\\]/).filter(Boolean);
    const repo = seg[seg.length - 1] ?? 'repo';
    const owner = seg[seg.length - 2] ?? '';
    return path.join(workspaceDir(), 'repos', repoName(owner ? `${owner}_${repo}` : repo) || repo);
}
/** 比较两个仓库地址是否是「同名不同组织」（同一个仓库换组织 vs 完全不相干的同名仓库，靠这里区分）。 */
function sameRepoNameOnly(a, b) {
    const tail = (u) => u.replace(/\.git$/, '').split(/[/\\]/).filter(Boolean).pop() ?? '';
    const ta = tail(a);
    return !!ta && ta === tail(b);
}
/** 库目录 = 仓库根 + 库子目录；未配仓库地址时退回按库名定位（历史行为）。 */
export function repoDirFor(lib) {
    const url = String(lib.repo_url ?? '').trim();
    if (!url)
        return path.join(workspaceDir(), 'repos', repoName(lib.name));
    return path.join(repoRootDir(url), normalizeSubpath(String(lib.repo_subpath ?? '')));
}
/** 读取本地克隆的 remote origin（用于识别"目录名与仓库不匹配"的历史克隆）。 */
function gitRemote(dir) {
    try {
        const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
        const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
        return normalizeRepoUrl(m?.[1] ?? '');
    }
    catch {
        return '';
    }
}
function gitHead(dir) {
    try {
        return runGitSync(['rev-parse', 'HEAD'], dir);
    }
    catch {
        return '';
    }
}
/**
 * 定位仓库检出目录，并顺手纠正历史命名。
 *
 * 旧版把单体仓按**库名**克隆到 `repos/json-schema`（内容其实是整个 openharmony_tpc_samples）。
 * 这里若确认"某个按库名命名的目录就是本库的仓库"，就改名到规范的 `repos/<owner>_<repo>`，
 * 让同仓的库直接复用（同卷改名是瞬时的，不复制数据）；改名失败则就地使用，不回退成重新克隆。
 *
 * 「就是本库的仓库」有两条判据，任一成立即可：
 *   ① 本地 remote 与目标地址一致；
 *   ② 本地 HEAD 与库表记录的 last_commit 一致 —— 这条是为**仓库换了组织/地址但内容没变**准备的
 *      （三方库测试表把地址从 `openharmony-tpc/x` 改成了 `CPF-ApplicationTPC/x`，其实是同一个仓库）。
 *      没有它，一次普通同步就会对着同一份代码再克隆 591MB。
 */
export function resolveRepoRootDir(repoUrl, legacyNames = [], expectedCommit = '') {
    const canonical = repoRootDir(repoUrl);
    const target = normalizeRepoUrl(repoUrl);
    if (fs.existsSync(path.join(canonical, '.git'))) {
        const remote = gitRemote(canonical);
        if (!remote || !target || remote === target)
            return canonical;
        if (sameRepoNameOnly(remote, target)) {
            // 同一个仓库换了组织/地址（三方库测试表就把 openharmony-tpc/x 改成了 CPF-ApplicationTPC/x）。
            // 复用本地克隆并把 remote 指到新地址：不这样处理，一次普通同步会重下 591MB 单体仓。
            try {
                runGitSync(['remote', 'set-url', 'origin', target], canonical);
                console.warn(`[autotest] 仓库地址组织变更：${path.basename(canonical)} 的 remote 由 ${remote} 改为 ${target}（复用本地克隆；若这其实是另一个项目，请删除该目录后重新拉取）`);
            }
            catch (e) {
                console.warn(`[autotest] 更新 remote 失败（继续用本地克隆）：${e.message}`);
            }
            return canonical;
        }
        // 同名但确实是另一个仓库（remote 仓库名都不同）→ 换一个带组织名的目录，绝不混用
        const alt = repoRootDirOwnered(repoUrl);
        console.warn(`[autotest] 仓库同名冲突：${path.basename(canonical)} 的 remote 是 ${remote}，与目标 ${target} 不是同一个仓库，改用 ${path.basename(alt)}`);
        return alt;
    }
    for (const legacy of legacyNames) {
        const dir = path.join(workspaceDir(), 'repos', repoName(legacy));
        if (samePath(dir, canonical))
            continue;
        if (!fs.existsSync(path.join(dir, '.git')))
            continue;
        const remoteOk = !!target && gitRemote(dir) === target;
        const commitOk = !!expectedCommit && gitHead(dir) === expectedCommit;
        if (!remoteOk && !commitOk)
            continue;
        try {
            fs.mkdirSync(path.dirname(canonical), { recursive: true });
            fs.renameSync(dir, canonical);
            console.log(`[autotest] 仓库目录改名：repos/${repoName(legacy)} → repos/${path.basename(canonical)}（${remoteOk ? '按远程地址确认' : '按上次同步提交确认'}，同仓库改为共享一份）`);
            return canonical;
        }
        catch (e) {
            console.warn(`[autotest] 仓库目录改名失败（继续就地使用 ${dir}）：${e.message}`);
            return dir;
        }
    }
    return canonical;
}
/** 保留旧签名（只给库名）时的便捷包装：库行里没有 repo_url 时用它。 */
export function repoRootForLib(lib) {
    const url = String(lib.repo_url ?? '').trim();
    return url
        ? resolveRepoRootDir(url, [lib.name], String(lib.last_commit ?? ''))
        : path.join(workspaceDir(), 'repos', repoName(lib.name));
}
/**
 * 解析已克隆仓库工程：bundleName / mainAbility / 页面列表 / 入口页代码（供 AI 设计真实 UI 用例）。
 * 用 `repoRootForLib` 而不是直接的规范路径：它会顺带把历史命名的克隆目录改名认领过来
 * （否则刚同步过地址的库会「解析不到包名」，因为代码其实在旧目录里）。
 */
export function inspectRepo(lib) {
    const url = String(lib.repo_url ?? '').trim();
    const dir = url
        ? path.join(repoRootForLib(lib), normalizeSubpath(String(lib.repo_subpath ?? '')))
        : repoDirFor(lib);
    const result = { dir, bundleName: '', abilityName: '', pages: [], entryDemo: '' };
    if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(path.join(dir, 'AppScope')) && !fs.existsSync(path.join(dir, 'entry')))
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
    const root = repoRootForLib(lib);
    if (!fs.existsSync(path.join(root, '.git')))
        return [];
    // 单体仓：只看本库子目录内的变更，否则会把同仓其它 250 个样本的改动也混进本库上下文
    const prefix = normalizeSubpath(String(lib.repo_subpath ?? ''));
    const args = (base) => (prefix ? [...base, '--', prefix] : base);
    try {
        const head = runGitSync(['rev-parse', 'HEAD'], root);
        if (lib.last_commit && lib.last_commit !== head) {
            return runGitSync(args(['diff', '--name-only', lib.last_commit, head]), root).split(/\r?\n/).filter(Boolean);
        }
        return runGitSync(args(['show', '--name-only', '--format=', 'HEAD']), root).split(/\r?\n/).filter(Boolean);
    }
    catch {
        return [];
    }
}
function runGitSync(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
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
    const { repoUrl: normalized, subpath } = splitRepoUrl(trimmed);
    const existing = await db.prepare('SELECT * FROM libraries WHERE repo_url = ? OR repo_url = ? OR repo_url = ?')
        .get(trimmed, normalized, normalized || trimmed);
    if (existing)
        return existing;
    // 单体仓子目录地址：库名取**子目录名**，不能取仓库名 —— 否则 168 个子目录库会全叫
    // `openharmony_tpc_samples`，互相撞名只能靠 -2/-3 后缀区分，身份完全不可读。
    const baseName = subpath ? subpath.split('/').filter(Boolean).pop() ?? '' : '';
    let name = repoName(baseName || deriveName(normalized));
    let n = 1;
    while (await db.prepare('SELECT id FROM libraries WHERE name = ?').get(name)) {
        name = `${repoName(baseName || deriveName(normalized))}-${++n}`;
    }
    const res = await db.prepare(`INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, status, created_at, updated_at)
    VALUES (?, ?, ?, '由任务创建（拉取仓库代码）', 'v0.0.0', 'active', ?, ?)`).run(name, normalized || trimmed, subpath, t, t);
    return (await db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(res.lastInsertRowid)));
}
/**
 * 版本号：整仓库用 `git describe` 的 tag，**子目录库不能用 tag**。
 * `git describe --tags` 看的是整个仓库的提交图，单体仓里它会把别的样本的 tag 贴到这个库上
 * （实测 json-schema 被标成了 `ohos_minizip_1.0.5`），所以子目录库改用「本子目录最后一次提交」的短 hash。
 */
async function describeVersion(dir, fallback, subpath = '') {
    if (subpath) {
        try {
            const short = await runGit(['log', '-1', '--format=%h', '--', subpath], dir);
            if (short)
                return `dev-${short}`;
        }
        catch { /* 落到 fallback */ }
        return fallback;
    }
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
    const subpath = normalizeSubpath(String(lib.repo_subpath ?? ''));
    // 克隆/更新都发生在**仓库根**：同仓的多个库共享一份克隆（否则单体仓会按库各存一份）
    const dir = repoRootForLib(lib);
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
    // 子目录库：克隆下来的是整个单体仓，必须校验库子目录真的存在，
    // 否则后续遍历会拿着一个空目录去解析工程，报出来的错会指向完全无关的地方。
    const libDir = repoDirFor(lib);
    if (subpath && !fs.existsSync(libDir)) {
        throw new Error(`仓库已同步到 ${dir}，但库子目录不存在：${subpath}。请检查「库管理」里的子目录填写是否正确（仓库分支的目录结构可能与预期不同）。`);
    }
    const commit = await runGit(['rev-parse', 'HEAD'], dir);
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    let changedFiles = [];
    if (action === 'pull' && prev && prev !== commit) {
        changedFiles = (await runGit(subpath ? ['diff', '--name-only', prev, commit, '--', subpath] : ['diff', '--name-only', prev, commit], dir)).split(/\r?\n/).filter(Boolean);
    }
    else if (action === 'clone' || !prev) {
        changedFiles = (await runGit(subpath ? ['show', '--name-only', '--format=', 'HEAD', '--', subpath] : ['show', '--name-only', '--format=', 'HEAD'], dir)).split(/\r?\n/).filter(Boolean);
    }
    const version = await describeVersion(dir, lib.current_version, subpath);
    await saveSync(lib.id, commit, version);
    // 拉取后解析包名/主 Ability 入库（供真机启动/遍历/首页展示）
    await refreshPackageInfo(lib);
    const changedCount = changedFiles.length;
    const where = subpath ? `（${path.basename(dir)} 仓库内子目录 ${subpath}）` : '';
    const summary = action === 'clone'
        ? `已克隆 ${lib.name}${where}（${branch} @ ${commit.slice(0, 8)}），当前版本 ${version}，最近提交含 ${changedCount} 个变更文件。`
        : `已更新 ${lib.name}${where}（${branch} @ ${commit.slice(0, 8)}），当前版本 ${version}${prev && prev !== commit ? `，自上次同步新增/变更 ${changedCount} 个文件` : '，无新变更'}。`;
    return { action, dir, branch, commit, changedFiles, changedCount, version, summary };
}
/** 更新仓库 = 拉取 + 变更文件明细。 */
export async function updateRepo(lib) {
    const r = await pullRepo(lib);
    const detail = r.changedFiles.length > 0 ? `\n变更文件（前 20）：${r.changedFiles.slice(0, 20).join(', ')}` : '';
    r.summary = `【更新仓库】${r.summary}${detail}`;
    return r;
}
