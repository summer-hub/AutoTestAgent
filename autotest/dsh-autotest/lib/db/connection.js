// 业务数据源：双引擎（自动降级）
//  - MySQL（默认，服务器化多用户）：配置了 db.mysqlUrl / AUTOTEST_MYSQL_URL / data/.mysql-url 时使用
//  - SQLite 本地降级：未配置任何 MySQL 连接时自动落到 <data>/autotest.sqlite3（轻量单文件库，
//    登录/业务/设置全部可用；AUTOTEST_DB_MODE=sqlite 可强制）
//  - 统一 facade：prepare().get/all/run + transaction（AsyncLocalStorage 事务上下文）
//  - 参数支持位置 ? 与命名 @name（内部转换为 ?）；SQLite 模式下自动翻译少量 MySQL 方言
import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { schemaStatements } from './schema.js';
import { sqliteSchemaStatements } from './schema-sqlite.js';
import { sqlite, dataDir } from './sqlite.js';
let pool = null;
/** 连接串引导：环境变量 → 数据目录/.mysql-url（迁移脚本写入）→ '' */
export function defaultUrlProvider() {
    if (process.env.AUTOTEST_MYSQL_URL)
        return process.env.AUTOTEST_MYSQL_URL.trim();
    try {
        // 走 dataDir()：引导文件跟库一起搬，不能把旧版插件包内的路径写死
        const f = path.join(dataDir(), '.mysql-url');
        if (fs.existsSync(f))
            return fs.readFileSync(f, 'utf8').trim();
    }
    catch { /* 忽略 */ }
    return '';
}
let urlProvider = defaultUrlProvider;
let readyPromise = null;
const txStore = new AsyncLocalStorage();
// ---------- SQLite 事务互斥（隔离性修复） ----------
// better-sqlite3 是「单连接 + 同步执行」：事务打开期间，别的并发请求发来的语句会落在同一条连接上，
// 从而被卷进本事务并随它一起 COMMIT/ROLLBACK（事务隔离被击穿）；两个事务交叠还会抛
// "cannot start a transaction within a transaction"。
// 这里用一把异步互斥锁把 SQLite 事务串行化，并让「事务外的语句」等到事务结束再执行：
//   - 事务进行中，只有事务自身（AsyncLocalStorage 标记）可以直接执行语句；
//   - 因此不存在"语句被卷进别人事务"的窗口，也不存在嵌套 BEGIN。
const sqliteTxStore = new AsyncLocalStorage();
let sqliteTxOpen = false;
let sqliteTxWaiters = [];
/** 挂起直到当前事务释放（由调用方在 while 条件里同步检查，避免"检查—置位"被 await 拆开）。 */
function sqliteIdleTick() {
    return new Promise((resolve) => { sqliteTxWaiters.push(resolve); });
}
/**
 * 抢占 SQLite 事务锁。
 * 注意：循环条件的检查与 `sqliteTxOpen = true` 之间**不能有任何 await**，
 * 否则会退化成"三个调用者都以为自己拿到了锁"，仍会打出嵌套 BEGIN。
 */
async function acquireSqliteTx() {
    while (sqliteTxOpen)
        await sqliteIdleTick();
    sqliteTxOpen = true; // 与上面的条件检查处于同一同步块 → 原子
}
function releaseSqliteTx() {
    sqliteTxOpen = false;
    const waiters = sqliteTxWaiters.splice(0);
    for (const w of waiters)
        w();
}
let lockedMode = null;
/** 当前数据库引擎：mysql（默认）| sqlite（未配置连接时本地降级）。ensureReady 后锁定。 */
export function dbMode() {
    if (lockedMode)
        return lockedMode;
    const forced = String(process.env.AUTOTEST_DB_MODE || '').trim().toLowerCase();
    let mode;
    if (forced === 'sqlite')
        mode = 'sqlite';
    else if (forced === 'mysql')
        mode = 'mysql';
    else {
        let url = '';
        try {
            url = urlProvider().trim();
        }
        catch { /* provider 异常按未配置处理 */ }
        mode = url ? 'mysql' : 'sqlite';
    }
    return mode;
}
/** 注入 MySQL 连接串提供者（index.ts 从 settings 缓存注入）。 */
export function setDbUrlProvider(fn) {
    urlProvider = fn;
}
export function mysqlPool() {
    if (!pool) {
        const url = urlProvider().trim();
        if (!url)
            throw new Error('未配置 MySQL 连接（系统配置 db.mysqlUrl 或环境变量 AUTOTEST_MYSQL_URL）');
        pool = mysql.createPool({
            uri: url,
            waitForConnections: true,
            connectionLimit: 12,
            charset: 'utf8mb4',
            timezone: 'Z',
            dateStrings: true,
            supportBigNumbers: true,
            bigNumberStrings: false,
        });
    }
    return pool;
}
/** MySQL 方言 → SQLite 方言的少量安全翻译。 */
function translateSqlite(s) {
    return s
        .replace(/INSERT\s+IGNORE/gi, 'INSERT OR IGNORE')
        .replace(/\sAS\s+UNSIGNED/gi, ' AS INTEGER');
}
/** 统一查询入口：事务上下文内走事务连接，否则走引擎。 */
async function query(sql, args) {
    if (dbMode() === 'sqlite') {
        // 事务外发起的语句必须等当前事务结束：否则会落到同一条连接上被卷进别人的事务。
        // 循环条件同步检查、退出后同步执行语句，中间不留 await 缺口。
        if (sqliteTxStore.getStore() !== true) {
            while (sqliteTxOpen)
                await sqliteIdleTick();
        }
        const s = translateSqlite(sql);
        const head = s.trimStart().slice(0, 6).toUpperCase();
        const stmt = sqlite().prepare(s);
        if (head.startsWith('SELECT') || head.startsWith('PRAGMA')) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return stmt.all(...args);
        }
        const info = stmt.run(...args);
        // 归一化为 mysql2 OkPacket 形态，供 facade.run 统一读取
        return { affectedRows: info.changes, insertId: Number(info.lastInsertRowid) };
    }
    const tx = txStore.getStore();
    if (tx) {
        const [rows] = await tx.query(sql, args);
        return rows;
    }
    const [rows] = await mysqlPool().query(sql, args);
    return rows;
}
export function now() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
// ---------- 参数转换（mysql2 不支持 @name 命名参数） ----------
function normalize(sql, params) {
    // 单个对象参数 → 命名参数 @name 转换；其余按位置参数
    if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
        const named = params[0];
        const args = [];
        const out = sql.replace(/@([A-Za-z0-9_]+)/g, (_, k) => {
            args.push(named[k]);
            return '?';
        });
        return { sql: out, args };
    }
    return { sql, args: params };
}
export function prepare(sql) {
    return {
        async get(...params) {
            const { sql: s, args } = normalize(sql, params);
            const rows = await query(s, args);
            return rows[0];
        },
        async all(...params) {
            const { sql: s, args } = normalize(sql, params);
            return await query(s, args);
        },
        async run(...params) {
            const { sql: s, args } = normalize(sql, params);
            const r = await query(s, args);
            return { changes: r.affectedRows, lastInsertRowid: Number(r.insertId) };
        },
    };
}
export function getDb() {
    return { prepare, exec, transaction };
}
/** 执行多语句（按分号拆分，供 DDL / 迁移用）。 */
export async function exec(sql) {
    const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
    for (const s of stmts) {
        await query(s, []);
    }
}
/**
 * 事务：MySQL 从池取连接；SQLite 走「互斥锁 + BEGIN/COMMIT」（见文件顶部 sqliteTxStore 说明）。
 * 嵌套调用语义：并入外层事务（内层不单独提交/回滚），避免 SQLite 自我死锁与 MySQL 连接池耗尽。
 */
export async function transaction(fn) {
    if (dbMode() === 'sqlite') {
        if (sqliteTxStore.getStore() === true) {
            // 已在外层事务内：直接并入，保证不出现嵌套 BEGIN
            return fn();
        }
        await acquireSqliteTx(); // 成功后即成为唯一持有者，后续非事务语句一律排队
        let begun = false;
        try {
            sqlite().exec('BEGIN IMMEDIATE');
            begun = true;
            const r = await sqliteTxStore.run(true, () => fn());
            sqlite().exec('COMMIT');
            begun = false;
            return r;
        }
        catch (e) {
            if (begun) {
                try {
                    sqlite().exec('ROLLBACK');
                }
                catch { /* ignore */ }
            }
            throw e;
        }
        finally {
            releaseSqliteTx();
        }
    }
    if (txStore.getStore()) {
        // MySQL 同样禁止嵌套开新事务：内层并入外层，避免行锁互相等待与连接池耗尽
        console.warn('[dsh-autotest] 检测到嵌套事务调用，已并入外层事务（内层不单独提交/回滚）');
        return fn();
    }
    const conn = await mysqlPool().getConnection();
    try {
        await conn.beginTransaction();
        const r = await txStore.run(conn, () => fn());
        await conn.commit();
        return r;
    }
    catch (e) {
        try {
            await conn.rollback();
        }
        catch { /* ignore */ }
        throw e;
    }
    finally {
        conn.release();
    }
}
/** 读路径（连接池/单文件库天然并发，直接走 facade）。 */
export async function withRead(fn) {
    return fn(getDb());
}
/**
 * 内置 Prompt v3 内容（ensureReady 升级用，MySQL/SQLite 共用）。
 *
 * v3 的两点变化：
 *   1. **技能绑定换人**：v2 绑的是 `autotest-case-author`（只给方法论、没有机械门禁），
 *      v3 改为强制走 `ohos-library-testcase-pipeline`（项目内 skills/ 目录，自带四类场景规则、
 *      判据取值域、可测性 A/B/C/D、demo 改造规范、机械自检与 xlsx 导出）。
 *      平台自己的「编写测试用例」「真机遍历生成用例」两个任务因此自动使用新技能。
 *   2. 把"可机器校验判据 / 四类场景适用性 / 不臆造控件"写进正文，而不是只写在技能里 ——
 *      用户若在设置页改过模板，正文里的硬要求仍然生效。
 */
const CASE_GEN_V3_CONTENT = '你是鸿蒙三方库 UI 测试用例设计 Agent（HarmonyOS/OpenHarmony）。\n【必须遵循的技能】本平台生成手工测试用例一律使用技能 ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md，按需读取其 references/）：它给出了四类场景的适用性依据、可机器校验判据的取值域、可测性 A/B/C/D 判定与 demo 最小改造规范。已废弃的 autotest-case-author 不再使用。\n【设计原则】以「真实可操作、逻辑合理、预期可机器校验」为准绳：\n1. 真实可操作——所有步骤必须基于给定上下文中真实存在的页面与控件（仓库工程解析或真机遍历 dump），严禁臆造按钮/菜单/跳转；控件文本要逐字一致；\n2. 逻辑合理——步骤顺序符合真实用户操作路径，前置条件完整；按四类场景展开（正向/空值/边界异常/大数据），**不适用就写明理由，不硬造**；\n3. 预期可机器校验（硬门槛）——每条用例必须给出可核对的判据：界面出现/消失的具体控件文本、控件文本等于/包含某值（含错误码）、勾选状态、hilog 关键字、无崩溃、截图差异之一。禁止「显示正常」「工作正常」「符合预期」这类无法核对的措辞，也禁止恒真断言。\n【库类别适配】先判断库的类别（动画渲染/网络请求/UI 组件/数据存储等），按类别选择验证手段：动画类验证播放/暂停/进度/循环；网络类验证请求成功/失败/超时回调与 hilog 输出；UI 组件类验证属性设置、事件回调、状态切换；其他类别按库简介推导并在用例中说明依据。\n【输出】JSON 数组：{ name, precondition, steps[], expected, oracles[] }，来源固定为 AI 生成。只输出 JSON。';
const CASE_GEN_V3_SKILL = [
    '【必须使用】ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md）。',
    '本平台"生成手工测试用例"一律走该技能；已废弃的 autotest-case-author 禁止使用（该技能只剩跳转说明）。',
    '三条硬性纪律（违反即作废）：',
    '① 假通过 0——每条用例必须有可机器校验判据（界面文本/控件文本/勾选状态/hilog 关键字/无崩溃/截图差异），禁止"正常/成功/符合预期"式措辞与恒真断言；',
    '② 不虚报覆盖——demo 里真实调用过 且 至少一条负向用例（空值或边界异常）才判"已覆盖"；只有正向只判部分覆盖，仅单元测试调用也只判部分覆盖，纯类型声明判不可测；',
    '③ 不臆造控件与结论——步骤引用的控件文本必须逐字来自真机 dump（devecocli ui layout）或工程源码；拿不到证据就写"未获取"，绝不编造。',
].join('\n');
// v2 的正文/技能文本已随 v3 删除（历史见 git）；不要再往 v2 上叠改动，升级只写 `version < N` 条件。
/**
 * 内置「用例优化 Agent」Prompt v2：技能绑定改为 ohos-library-testcase-pipeline。
 *
 * 为什么优化也绑同一个技能：优化在做的事就是"按未覆盖项补用例 + 改写不合格用例"，
 * 用的是同一套场景适用性（S4）、同一道判据门槛（S6）与同一份 demo 改造规范（S5）。
 * 绑成两套规则，两边的"什么算合格用例"迟早会走形 —— 这正是 v1 绑的那个
 * `autotest-case-optimizer` 的问题（该技能在 skills/ 目录里根本不存在，是悬空引用）。
 */
const CASE_OPT_V2_CONTENT = '你是鸿蒙三方库测试用例优化 Agent。在保持原用例测试意图与覆盖目标不变的前提下提升质量。\n【必须遵循的技能】与用例生成同一套规则：ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md）—— 补缺按 S4 的场景适用性（不适用要写理由，不硬造），判据按 S6 的取值域（可机器校验），需要改 demo 的按 S5 的规范（副本 + 最小改造 + 构建 + 真机验证）。\n【优化准绳】\n1. 真实可操作——步骤引用的控件必须来自给定上下文（页面源码/真机遍历控件清单），删除或修正臆造的按钮与跳转；\n2. 逻辑合理——补全前置条件，理顺操作顺序，拆分过长的组合步骤，去除重复；新增用例只补真正的缺口（接口无用例 / 缺负向场景），不堆数量；\n3. 预期可机器校验（硬门槛）——每条用例必须有可核对的判据（界面文本/控件文本/勾选状态/hilog 关键字/无崩溃/截图差异），禁止「显示正常」「工作正常」「符合预期」式措辞与恒真断言；内容超一屏时补「向上滑动查看输出区域」步骤；\n4. 输出 JSON：{ name, precondition, steps[], expected, oracles[] }。只输出 JSON，不要解释。';
const CASE_OPT_V2_SKILL = [
    '【必须使用】ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md）——与用例生成同一套规则。',
    '已废弃的 autotest-case-optimizer 不再使用（该名字在 skills/ 目录里没有对应文件，属悬空引用）。',
    '三条硬性纪律（与用例生成一致）：① 假通过 0——每条用例都要有可机器校验判据，禁止含糊措辞与恒真断言；',
    '② 不虚报覆盖——只补真缺口，demo 真实调用 + 至少一条负向才算已覆盖；',
    '③ 不臆造控件——步骤里的控件文本必须逐字来自真机 dump 或工程源码。',
    '补缺时按 S4 判定场景适用性；需要改 demo 按 S5（副本 + 最小改造 + 构建 + 真机验证）。',
].join('\n');
/**
 * 内置「脚本生成 Agent」Prompt v2：手工用例 → Hypium 自动化脚本这一步的绑定。
 * 该阶段是确定性模板生成（不花 token），这里主要是把**约定与纪律**摆出来，
 * 并在 agent_bindings 覆盖该阶段时作为对照基准。
 */ const SCRIPT_GEN_CONTENT = [
    '你是鸿蒙三方库"手工用例 → Hypium 自动化脚本"的执行者。这一步走**确定性模板**，不靠模型自由发挥。',
    '【产出】<工程根>/testcases/<lib>/<lib>_<caseNo>.py 与同名 .json（成对，缺一不可）。',
    '【命名四方一致】文件名 = Python 类名 = main.py 的 -l 模块名 = 报告里的模块名。',
    '【纪律】① 步骤无法映射到 hypium 调用就**失败**，不写注释行；② 没有判据的用例**拒绝生成脚本**（否则必然假通过）；',
    '③ 只调用核实存在的 driver API，控件文本逐字来自真机 dump 或工程源码。',
    '【判定】报告看 reports/<时间戳>/summary_report.xml，精确匹配模块名；通过但零断言校验 = 假通过，判失败。',
].join('\n');
const SCRIPT_GEN_SKILL = [
    '【必须使用】ohos-case-to-hypium（仓库内 skills/ohos-case-to-hypium/SKILL.md）。',
    '它定义了单工程多库布局（testcases/<lib>/ + 共享 aw/）、命名四方一致、步骤/判据映射与失败归因三分法。',
    '硬性纪律：无法映射的步骤直接失败（不写注释行）；断言为空不许落盘；只调用核实存在的 hypium API。',
].join('\n');
/**
 * demo 侧的三个技能绑定（内置 Prompt，供「提示词管理」查看/调整，也可被 agent_bindings 覆盖）。
 *
 * 它们组成一条链，把"规划场景 → 量化 demo 覆盖 → 补 demo 代码"接起来：
 *   demo 解析   ← ohos-demo-scenario-generator（接口规格 → 正/反向场景清单）
 *   覆盖矩阵    ← ohos-demo-coverage-analyzer（场景文档 × entry 代码 → 覆盖率与盲区）
 *   demo 补丁   ← ohos-demo-code-generator（场景描述 → 可编译运行的 ArkTS demo 代码）
 *
 * 说明：平台自己的 demo 资产扫描/矩阵装配是**确定性代码**（不调模型），
 * 这三个绑定主要作用于 agent 驱动的路径（人/AI 按技能做 demo 规划与补齐），
 * 以及被 agent_bindings 覆盖时作为基准 —— 不要把它们当成"平台会自动执行"。
 */
export const DEMO_STAGE_PROMPTS = [
    {
        name: 'demo 场景规划 Agent', role: 'demo 解析',
        content: [
            '把三方库的接口规格转成 Demo 测试场景清单：正向（常规用法）+ 反向（空值/边界/异常），每个场景写清名称、描述、功能点、关键体验指标、用户期望与设计关注点。只依据接口规格文档与真实源码，不臆造接口。',
            '【产出】workspace/coverage/<库名>/<库名>Demo场景.md。',
            '【格式契约】平台会按下列结构解析（解析不出来只会告警，不会猜）：',
            '  1) 场景块标题：`#### P01 名称`（正向）/ `#### N01 名称`（反向），编号唯一；',
            '  2) 每个场景块内必须有这三行：`**场景类型**：正向|反向`、`**模块**：<功能模块名>`、`**场景涉及的功能点**`；',
            '  3) 功能点每条写成 `- 说明（对应接口：`Validator.validate()`）` —— 反引号里的接口名就是接口覆盖率的分母，一条一个；',
            '  4) 开头的「功能模块映射」表保留（模块 × 接口 × 正/反向场景编号），它用于交叉核对模块归属。',
            '【纪律】接口名必须逐字来自接口规格文档；场景必须能被真机上的一次操作触发（说不清真机怎么点的场景不要写）。',
        ].join('\n'),
        skill: '【必须使用】ohos-demo-scenario-generator（仓库内 skills/ohos-demo-scenario-generator/SKILL.md）：产出「库名+Demo场景.md」，作为 demo 覆盖分析与补代码的输入。',
    },
    {
        name: 'demo 覆盖分析 Agent', role: '覆盖矩阵',
        content: [
            '对比 Demo 场景文档与 entry 目录现有代码，量化"规划的场景有多少真的被 demo 覆盖"，逐条给出已覆盖/部分覆盖/未覆盖与差距证据，并给出可执行的补充优先级。没有证据的结论不要写。',
            '【产出】workspace/coverage/<库名>/<库名>Demo场景覆盖率报告.md。',
            '【格式契约】平台会解析这两张表并做自洽核对（结论缺行、悬空、状态与接口覆盖率矛盾都会报警）：',
            '  1) 「正向场景覆盖」/「反向场景覆盖」表，6 列固定为：编号 | 场景名称 | 覆盖状态 | 接口覆盖率 | 匹配文件（行号） | 差距说明；',
            '     覆盖状态只能写 ✅ / 🔶 / ❌；接口覆盖率写成 `已调用/场景涉及总数 (百分比)`，例如 `2/3 (67%)`；',
            '  2) 「接口维度逐条核对」表：接口 / 选项 | demo 是否真实执行 | 证据，第二列只能写 ✅（真实执行）或 ⚠️ 开头（有条件/未生效）或 ❌（零调用）；',
            '  3) 判 ❌ 但接口覆盖率 > 0 时，必须在「差距说明」里说清"接口有调用点为什么仍不算覆盖"，否则平台会报警。',
            '【纪律】状态与证据必须自洽：说完全覆盖就要接口覆盖率 100%；说未覆盖就不要在匹配文件列写上是哪个页面。',
        ].join('\n'),
        skill: '【必须使用】ohos-demo-coverage-analyzer（仓库内 skills/ohos-demo-coverage-analyzer/SKILL.md）：它把覆盖度量化成可核对的比例与清单，与本平台 P3 覆盖矩阵（接口维度）互补：一个看接口覆盖，一个看场景/代码覆盖。',
    },
    {
        name: 'demo 代码生成 Agent', role: 'demo 补丁',
        content: '按场景描述生成可编译运行的 ArkTS demo 代码：每个 Demo 一个独立 .ets 页面，主页统一导航，含 hilog 日志、错误处理与必要注释。生成的代码必须真机验证（构建 + 跑通），未验证要写明。',
        skill: '【必须使用】ohos-demo-code-generator（仓库内 skills/ohos-demo-code-generator/SKILL.md）：它规定了页面命名、导航接入、权限适配与代码质量检查；注意它依赖 knowledge-base MCP 查 HarmonyOS API 签名（不可用时如实降级）。',
    },
];
/**
 * 内置 Prompt 升级（facade 执行，双引擎通用）。
 *
 * 升级条件一律写成 `version < N`：**人工编辑会 version+1**（见 PUT /prompts/:id），
 * 所以被用户改过的内置模板会自然跳过升级，不会被自动覆盖 —— 这是"人手改的东西机器不能冲掉"。
 */
async function upgradeBuiltinPrompts() {
    try {
        await getDb().prepare(`UPDATE prompts SET content = ?, skill = ?, variables = '[]', version = 3, updated_at = ?
       WHERE role = '用例生成' AND builtin = 1 AND version < 3`).run(CASE_GEN_V3_CONTENT, CASE_GEN_V3_SKILL, now());
    }
    catch (e) {
        console.warn('[dsh-autotest] 内置 Prompt 升级跳过：', e.message);
    }
    // 「用例优化 Agent」升级到 v2：技能绑定从悬空的 autotest-case-optimizer 换成
    // ohos-library-testcase-pipeline —— 优化本质仍是在同一套规则下补用例（S4 场景适用性 / S5 补缺 /
    // S6 判据门槛），绑成两套规则反而容易走形。条件用 `version < 2`：老库该行是 v1，会被升级；
    // 用户手改过的行 version 已 ≥2，自动跳过。
    try {
        await getDb().prepare(`UPDATE prompts SET content = ?, skill = ?, variables = '[]', version = 2, updated_at = ?
       WHERE role = '用例优化' AND builtin = 1 AND version < 2`).run(CASE_OPT_V2_CONTENT, CASE_OPT_V2_SKILL, now());
    }
    catch (e) {
        console.warn('[dsh-autotest] 用例优化 Prompt 升级跳过：', e.message);
    }
    // 老库补插「用例优化 Agent」（不存在时插入；用户改过/已建则跳过）。插入即 v2，与新装播种一致。
    try {
        const insertSql = dbMode() === 'sqlite'
            ? `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
         SELECT '用例优化 Agent', '用例优化', ?, ?, '[]', 1, 2, ?
         WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = '用例优化')`
            : `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
         SELECT '用例优化 Agent', '用例优化', ?, ?, '[]', 1, 2, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = '用例优化')`;
        await getDb().prepare(insertSql).run(CASE_OPT_V2_CONTENT, CASE_OPT_V2_SKILL, now());
    }
    catch (e) {
        console.warn('[dsh-autotest] 用例优化 Agent 补插跳过：', e.message);
    }
    // 老库补插「脚本生成 Agent」（手工用例 → Hypium 脚本这一步的绑定；不存在时插入）
    try {
        const insertSql = dbMode() === 'sqlite'
            ? `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
         SELECT '脚本生成 Agent', '脚本生成', ?, ?, '[]', 1, 2, ?
         WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = '脚本生成')`
            : `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
         SELECT '脚本生成 Agent', '脚本生成', ?, ?, '[]', 1, 2, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = '脚本生成')`;
        await getDb().prepare(insertSql).run(SCRIPT_GEN_CONTENT, SCRIPT_GEN_SKILL, now());
    }
    catch (e) {
        console.warn('[dsh-autotest] 脚本生成 Agent 补插跳过：', e.message);
    }
    // 老库补插 demo 侧三个阶段（场景规划 / 覆盖分析 / demo 代码生成）的技能绑定
    for (const row of DEMO_STAGE_PROMPTS) {
        try {
            const insertSql = dbMode() === 'sqlite'
                ? `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
           SELECT ?, ?, ?, ?, '[]', 1, 1, ?
           WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = ?)`
                : `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
           SELECT ?, ?, ?, ?, '[]', 1, 1, ? FROM DUAL
           WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = ?)`;
            await getDb().prepare(insertSql).run(row.name, row.role, row.content, row.skill, now(), row.role);
        }
        catch (e) {
            console.warn(`[dsh-autotest] ${row.role} 绑定补插跳过：`, e.message);
        }
    }
}
/** 建表 + settings 加载 + 种子（幂等，首次请求前完成）。 */
export async function ensureReady() {
    if (!readyPromise) {
        readyPromise = (async () => {
            if (dbMode() === 'sqlite') {
                // ---- SQLite 本地降级 ----
                for (const stmt of sqliteSchemaStatements()) {
                    try {
                        await query(stmt, []);
                    }
                    catch (e) {
                        console.warn(`[sqlite] ${String(stmt).slice(0, 40)}…: ${e.message}`);
                    }
                }
                // 列迁移（新版本补列）：PRAGMA table_info 检查后 ALTER
                for (const [table, col] of [
                    ['libraries', 'package_name'], ['libraries', 'main_ability'], ['libraries', 'repo_subpath'],
                    ['cases', 'api_symbol_id'], ['cases', 'scenario_kind'], ['cases', 'priority'], ['api_symbols', 'detail_level'],
                    ['cases', 'testability'], ['cases', 'testability_reason'], ['cases', 'demo_patch_json'], ['cases', 'oracle_json'],
                    ['plans', 'script_mode'], ['plans', 'error'], ['plans', 'progress'], ['plans', 'progress_note'],
                    ['tasks', 'trace_id'], ['executions', 'trace_id'], ['executions_archive', 'trace_id'],
                ]) {
                    try {
                        const cols = await query(`PRAGMA table_info(${table})`, []);
                        if (Array.isArray(cols) && !cols.some((c) => c.name === col)) {
                            const ddl = {
                                'libraries:package_name': "ALTER TABLE libraries ADD COLUMN package_name TEXT NOT NULL DEFAULT ''",
                                'libraries:main_ability': "ALTER TABLE libraries ADD COLUMN main_ability TEXT NOT NULL DEFAULT ''",
                                'libraries:repo_subpath': "ALTER TABLE libraries ADD COLUMN repo_subpath TEXT NOT NULL DEFAULT ''",
                                'cases:api_symbol_id': 'ALTER TABLE cases ADD COLUMN api_symbol_id INTEGER NULL',
                                'cases:scenario_kind': "ALTER TABLE cases ADD COLUMN scenario_kind TEXT NOT NULL DEFAULT 'happy'",
                                'api_symbols:detail_level': "ALTER TABLE api_symbols ADD COLUMN detail_level TEXT NOT NULL DEFAULT 'name-only'",
                                'cases:priority': "ALTER TABLE cases ADD COLUMN priority TEXT NOT NULL DEFAULT 'P1'",
                                'cases:testability': "ALTER TABLE cases ADD COLUMN testability TEXT NOT NULL DEFAULT ''",
                                'cases:testability_reason': "ALTER TABLE cases ADD COLUMN testability_reason TEXT NOT NULL DEFAULT ''",
                                'cases:demo_patch_json': "ALTER TABLE cases ADD COLUMN demo_patch_json TEXT NOT NULL DEFAULT ''",
                                'cases:oracle_json': "ALTER TABLE cases ADD COLUMN oracle_json TEXT NOT NULL DEFAULT '[]'",
                                'plans:script_mode': "ALTER TABLE plans ADD COLUMN script_mode TEXT NOT NULL DEFAULT ''",
                                'plans:error': "ALTER TABLE plans ADD COLUMN error TEXT NOT NULL DEFAULT ''",
                                'plans:progress': 'ALTER TABLE plans ADD COLUMN progress INTEGER NOT NULL DEFAULT 0',
                                'plans:progress_note': "ALTER TABLE plans ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''",
                                'tasks:trace_id': "ALTER TABLE tasks ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''",
                                'executions:trace_id': "ALTER TABLE executions ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''",
                                'executions_archive:trace_id': "ALTER TABLE executions_archive ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''",
                            };
                            await query(ddl[`${table}:${col}`], []);
                        }
                    }
                    catch { /* 已存在则跳过 */ }
                }
                const { loadSettings } = await import('../services/settings.js');
                await loadSettings();
                const row = await getDb().prepare('SELECT COUNT(*) AS n FROM libraries').get();
                if (!row || row.n === 0) {
                    const { seed } = await import('./seed.js');
                    await seed();
                }
                await upgradeBuiltinPrompts();
                lockedMode = 'sqlite';
                console.log(`[dsh-autotest] 业务库就绪（SQLite 本地模式 · ${path.join(dataDir(), 'autotest.sqlite3')}）`);
                return;
            }
            // ---- MySQL 模式 ----
            for (const stmt of schemaStatements()) {
                try {
                    await mysqlPool().query(stmt);
                }
                catch (e) {
                    const msg = e.message;
                    if (/Duplicate key name|already exists/i.test(msg))
                        continue;
                    throw e;
                }
            }
            // 轻量迁移：旧库补充包名/主 Ability 列 + 计划脚本模式/错误信息列 + 归档 trace_id
            for (const [, , ddl] of [
                ['libraries', 'package_name', "ALTER TABLE libraries ADD COLUMN package_name VARCHAR(128) NOT NULL DEFAULT ''"],
                ['libraries', 'main_ability', "ALTER TABLE libraries ADD COLUMN main_ability VARCHAR(255) NOT NULL DEFAULT ''"],
                ['libraries', 'repo_subpath', "ALTER TABLE libraries ADD COLUMN repo_subpath VARCHAR(512) NOT NULL DEFAULT ''"],
                ['cases', 'api_symbol_id', 'ALTER TABLE cases ADD COLUMN api_symbol_id BIGINT UNSIGNED NULL'],
                ['cases', 'scenario_kind', "ALTER TABLE cases ADD COLUMN scenario_kind VARCHAR(16) NOT NULL DEFAULT 'happy'"],
                ['api_symbols', 'detail_level', "ALTER TABLE api_symbols ADD COLUMN detail_level VARCHAR(16) NOT NULL DEFAULT 'name-only'"],
                ['cases', 'priority', "ALTER TABLE cases ADD COLUMN priority VARCHAR(4) NOT NULL DEFAULT 'P1'"],
                ['cases', 'testability', "ALTER TABLE cases ADD COLUMN testability VARCHAR(8) NOT NULL DEFAULT ''"],
                ['cases', 'testability_reason', "ALTER TABLE cases ADD COLUMN testability_reason VARCHAR(500) NOT NULL DEFAULT ''"],
                ['cases', 'demo_patch_json', 'ALTER TABLE cases ADD COLUMN demo_patch_json MEDIUMTEXT NOT NULL'],
                ['cases', 'oracle_json', 'ALTER TABLE cases ADD COLUMN oracle_json MEDIUMTEXT NOT NULL'],
                ['executions_archive', 'trace_id', "ALTER TABLE executions_archive ADD COLUMN trace_id VARCHAR(64) NOT NULL DEFAULT ''"],
                ['plans', 'script_mode', "ALTER TABLE plans ADD COLUMN script_mode VARCHAR(16) NOT NULL DEFAULT ''"],
                ['plans', 'error', "ALTER TABLE plans ADD COLUMN error VARCHAR(500) NOT NULL DEFAULT ''"],
                ['plans', 'progress', 'ALTER TABLE plans ADD COLUMN progress INT NOT NULL DEFAULT 0'],
                ['plans', 'progress_note', "ALTER TABLE plans ADD COLUMN progress_note VARCHAR(300) NOT NULL DEFAULT ''"],
                ['tasks', 'trace_id', "ALTER TABLE tasks ADD COLUMN trace_id VARCHAR(64) NOT NULL DEFAULT ''"],
                ['executions', 'trace_id', "ALTER TABLE executions ADD COLUMN trace_id VARCHAR(64) NOT NULL DEFAULT ''"],
            ]) {
                try {
                    await mysqlPool().query(ddl);
                }
                catch (e) {
                    if (!/Duplicate column/i.test(e.message))
                        throw e;
                }
            }
            // settings 内存缓存加载（来自 MySQL settings 表）
            const { loadSettings } = await import('../services/settings.js');
            await loadSettings();
            // 内置 Prompt 升级：用例生成 Agent → v3（技能绑定改为 ohos-library-testcase-pipeline）
            // 仅当未被人工改过（version < 3）；改过则 version 已 ≥3，自动跳过
            try {
                await mysqlPool().query(`UPDATE prompts SET content = ?, skill = ?, variables = '[]', version = 3, updated_at = NOW()
           WHERE role = '用例生成' AND builtin = 1 AND version < 3`, [CASE_GEN_V3_CONTENT, CASE_GEN_V3_SKILL]);
            }
            catch (e) {
                console.warn('[dsh-autotest] 内置 Prompt 升级跳过：', e.message);
            }
            // 种子：libraries 为空时灌入
            const row = await getDb().prepare('SELECT COUNT(*) AS n FROM libraries').get();
            if (!row || row.n === 0) {
                const { seed } = await import('./seed.js');
                await seed();
            }
            lockedMode = 'mysql';
            console.log('[dsh-autotest] 业务库就绪（MySQL）');
        })().catch((e) => {
            readyPromise = null;
            throw e;
        });
    }
    return readyPromise;
}
