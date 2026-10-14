// envkit 脚本注册表：内置契约 + DB 覆盖，统一查询入口。
//
// 为什么要有 DB 覆盖（script_library 表）：内置脚本随包分发，但企业环境下
// 往往要改超时、换构建命令、关掉某个步骤。允许在表里覆盖内置项，
// 就不必改代码重新发版；`builtin=0` 的条目是纯自定义资产。
//
// 优先级：DB 覆盖 > 内置。同一 id 在 DB 里出现即以 DB 为准（enabled=0 可软禁用）。
import { getDb, now } from '../../db/connection.js';
import { validateContract, contractFingerprint } from './contract.js';
import { BUILTIN_SCRIPTS, builtinScript } from './builtin.js';
function toRow(r) {
    const contract = JSON.parse(String(r.contract_json ?? '{}'));
    return {
        id: String(r.id), summary: String(r.summary), version: String(r.version),
        contract, contractJson: String(r.contract_json ?? '{}'),
        entryJson: String(r.entry_json ?? '{}'),
        sha256: String(r.sha256 ?? ''), approval: String(r.approval ?? 'operator'),
        enabled: Number(r.enabled ?? 1) === 1, builtin: Number(r.builtin ?? 0) === 1,
        updatedAt: String(r.updated_at ?? ''),
    };
}
/** 全量脚本（内置 + DB 覆盖合并，DB 优先）。 */
export async function listScripts() {
    const rows = await getDb().prepare('SELECT * FROM script_library ORDER BY id').all();
    const dbById = new Map(rows.map((r) => [String(r.id), toRow(r)]));
    const out = [];
    const seen = new Set();
    for (const b of BUILTIN_SCRIPTS) {
        seen.add(b.id);
        const override = dbById.get(b.id);
        if (override) {
            out.push(override);
            continue;
        }
        out.push({
            id: b.id, summary: b.summary, version: b.version, contract: b,
            contractJson: JSON.stringify(b), entryJson: JSON.stringify({ entry: b.entry }),
            sha256: contractFingerprint(b), approval: b.approval, enabled: true, builtin: true, updatedAt: '',
        });
    }
    // 纯自定义资产（DB 里有、内置没有的）
    for (const r of rows) {
        if (!seen.has(String(r.id)))
            out.push(toRow(r));
    }
    return out;
}
/** 取单个脚本（DB 覆盖优先，否则内置）。 */
export async function getScript(id) {
    const row = await getDb().prepare('SELECT * FROM script_library WHERE id = ?').get(id);
    if (row)
        return toRow(row);
    const b = builtinScript(id);
    if (!b)
        return null;
    return {
        id: b.id, summary: b.summary, version: b.version, contract: b,
        contractJson: JSON.stringify(b), entryJson: JSON.stringify({ entry: b.entry }),
        sha256: contractFingerprint(b), approval: b.approval, enabled: true, builtin: true, updatedAt: '',
    };
}
/** 把内置脚本播种进 DB（幂等：INSERT IGNORE，人改过的行不动）。 */
export async function seedBuiltinScripts() {
    let inserted = 0;
    const t = now();
    for (const b of BUILTIN_SCRIPTS) {
        const res = await getDb().prepare(`INSERT IGNORE INTO script_library
      (id, summary, version, contract_json, entry_json, sha256, approval, enabled, builtin, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`)
            .run(b.id, b.summary, b.version, JSON.stringify(b), JSON.stringify({ entry: b.entry }), contractFingerprint(b), b.approval, t);
        if (Number(res.changes ?? 0) > 0)
            inserted++;
    }
    return { inserted, total: BUILTIN_SCRIPTS.length };
}
/** 校验全部脚本的契约（供自检与「脚本库」页展示）。 */
export async function validateAllScripts() {
    const scripts = await listScripts();
    const problems = [];
    for (const s of scripts) {
        const p = validateContract(s.contract);
        if (p.length > 0)
            problems.push({ id: s.id, problems: p });
    }
    return { total: scripts.length, valid: scripts.length - problems.length, problems };
}
/** 契约漂移检测：DB 里的 sha256 与当前契约算出来的是否一致（升级后契约变了会被抓到）。 */
export async function detectContractDrift() {
    const scripts = await listScripts();
    const drift = [];
    for (const s of scripts) {
        const cur = contractFingerprint(s.contract);
        if (s.sha256 && s.sha256 !== cur)
            drift.push({ id: s.id, stored: s.sha256, current: cur });
    }
    return drift;
}
