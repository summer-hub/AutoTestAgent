// envkit 契约层：脚本资产的「可校验形状」。
//
// 为什么契约必须是数据而不是代码里的约定：脚本库是企业级资产，契约固化了
// 「输入 / 输出 / 适用条件 / 失败分类 / 幂等 / 超时 / 审批等级」七件事，
// runner 才能统一做参数校验、产物采集、退出码归一与失败归类。
// 契约写坏必须在**加载时**就被抓住，而不是等脚本在真机上跑半小时后才报"参数少了"。
//
// 本文件是纯函数区（无 IO、无 DB）：契约的校验、失败分类码表、退出码归一化都在这里，
// 由 verify-envkit 离线覆盖。
import path from 'node:path';
import { createHash } from 'node:crypto';
/** 失败分类（failure_taxonomy 的取值域）。归类决定"人该做什么"，不是给人看的一行错误。 */
export const FAILURE_KINDS = [
    'network', // 拉依赖/克隆超时、DNS、代理
    'permission', // 文件/目录权限、需要管理员
    'toolchain_missing', // deveco-cli / hvigorw / ohpm / hdc 不存在
    'sdk_version_conflict', // SDK/API level/ohpm 源版本不匹配
    'compile_error', // 编译失败
    'missing_dep', // 缺二进制依赖/子模块/配置文件
    'device_offline', // 设备离线/未授权
    'artifact_not_found', // 构建成功但找不到预期产物
    'timeout', // 超时（与上面的网络超时分开：这里是步骤级超时）
    'cancelled', // 任务取消（不是失败，但要有独立归类）
    'unknown', // 未归类——出现即说明码表该扩了
];
/** 退出码归一化：脚本各自定义退出码，平台只认这四个。 */
export const EXIT_CODES = {
    OK: 0, // 成功
    BIZ_FAILED: 1, // 业务失败（编译失败、依赖装不上）
    ENV_MISSING: 2, // 环境缺失（工具不存在）
    TIMEOUT: 3, // 超时
    CANCELLED: 4, // 取消
};
/** 工具链探测：这些命令不存在 → ENV_MISSING，不该往 compile_error 里归。 */
export const TOOLCHAIN_BINS = ['deveco-cli', 'devecocli', 'hvigorw', 'ohpm', 'hdc', 'git', 'node'];
/**
 * 校验契约。返回问题清单（空 = 合法）。
 *
 * 为什么要这么严：契约是 runner 的唯一依据，id 冲突会让两个脚本互相顶掉；
 * failure_taxonomy 漏了 timeout，超时就会被归成 unknown（人不知道该修什么）；
 * 输出不声明 path，产物采集就无从判断"到底该有什么文件"。
 */
export function validateContract(c) {
    const problems = [];
    const at = (p) => problems.push({ path: p, reason: '' });
    if (!c.id || !/^[a-z][a-z0-9_]*$/.test(c.id)) {
        at('id');
        problems[problems.length - 1].reason = `id 必须是小写字母开头、仅含小写字母数字下划线：${JSON.stringify(c.id)}`;
    }
    if (!c.summary || c.summary.length < 4) {
        at('summary');
        problems[problems.length - 1].reason = 'summary 至少 4 字符（CLI help 与审批列表都用它）';
    }
    if (!c.entry || c.entry.includes('..') || path.isAbsolute(c.entry)) {
        at('entry');
        problems[problems.length - 1].reason = `entry 必须是 scripts/env/ 下的相对路径且不得含 ..：${JSON.stringify(c.entry)}`;
    }
    if (!c.version || !/^\d+\.\d+\.\d+/.test(c.version)) {
        at('version');
        problems[problems.length - 1].reason = 'version 需形如 1.0.0';
    }
    // 输入：名称唯一、类型合法、enum 必须有 values、默认值要能过类型检查
    const seenIn = new Set();
    for (const [i, p] of (c.inputs ?? []).entries()) {
        const where = `inputs[${i}](${p?.name ?? '?'})`;
        if (!p?.name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name)) {
            at(where);
            problems[problems.length - 1].reason = '参数名需为合法标识符';
            continue;
        }
        if (seenIn.has(p.name)) {
            at(where);
            problems[problems.length - 1].reason = `参数名重复：${p.name}`;
            continue;
        }
        seenIn.add(p.name);
        if (!['string', 'path', 'number', 'boolean', 'enum'].includes(p.type)) {
            at(where);
            problems[problems.length - 1].reason = `未知参数类型：${String(p.type)}`;
        }
        if (p.type === 'enum' && (!p.values || p.values.length === 0)) {
            at(where);
            problems[problems.length - 1].reason = 'enum 参数必须给出 values';
        }
        if (p.default !== undefined) {
            const t = typeof p.default;
            const ok = (p.type === 'number' && t === 'number') || (p.type === 'boolean' && t === 'boolean')
                || (p.type === 'string' || p.type === 'path' || p.type === 'enum') && t === 'string';
            if (!ok) {
                at(where);
                problems[problems.length - 1].reason = `默认值类型与声明不符：${String(p.default)}`;
            }
            if (p.type === 'enum' && p.values && !p.values.includes(String(p.default))) {
                at(where);
                problems[problems.length - 1].reason = '默认值不在 values 内';
            }
        }
    }
    // 输出：名称唯一；path 型必须有名字（产物采集要靠它）
    const seenOut = new Set();
    for (const [i, o] of (c.outputs ?? []).entries()) {
        const where = `outputs[${i}](${o?.name ?? '?'})`;
        if (!o?.name) {
            at(where);
            problems[problems.length - 1].reason = '输出必须有名字';
            continue;
        }
        if (seenOut.has(o.name)) {
            at(where);
            problems[problems.length - 1].reason = `输出名重复：${o.name}`;
            continue;
        }
        seenOut.add(o.name);
    }
    // 失败分类：至少一个；必须含 timeout 或明确不做超时（None 不在表里就得有 unknown）
    const tax = c.failure_taxonomy ?? [];
    if (tax.length === 0) {
        at('failure_taxonomy');
        problems[problems.length - 1].reason = '至少声明一种失败分类';
    }
    for (const k of tax) {
        if (!FAILURE_KINDS.includes(k)) {
            at('failure_taxonomy');
            problems[problems.length - 1].reason = `未知失败分类：${String(k)}`;
        }
    }
    if (tax.length > 0 && tax.every((k) => k !== 'unknown') && !tax.includes('timeout') && c.timeout_sec > 0) {
        // 不算错：脚本可能天然不会超时。但既声明了 timeout_sec 又不归 timeout 类，
        // 超时会被归成 unknown，所以要求要么归 timeout、要么声明 unknown。
        at('failure_taxonomy');
        problems[problems.length - 1].reason = '设置了 timeout_sec 就必须把 timeout 纳入失败分类（否则超时会被归成 unknown）';
    }
    if (!(c.timeout_sec > 0)) {
        at('timeout_sec');
        problems[problems.length - 1].reason = 'timeout_sec 必须为正（脚本可能真跑几十分钟，但也得有上限）';
    }
    if (c.timeout_sec > 7200) {
        at('timeout_sec');
        problems[problems.length - 1].reason = 'timeout_sec 超过 2 小时：请拆步骤，单步不该跑这么久';
    }
    if (!['none', 'operator', 'admin'].includes(c.approval)) {
        at('approval');
        problems[problems.length - 1].reason = `未知审批等级：${String(c.approval)}`;
    }
    for (const os of c.applies_when?.os ?? []) {
        if (!['windows', 'linux', 'darwin'].includes(os)) {
            at('applies_when.os');
            problems[problems.length - 1].reason = `未知 OS：${String(os)}`;
        }
    }
    return problems;
}
/** 契约内容哈希（供供应链锁与版本比对；与 skills-lock 同思路）。 */
export function contractFingerprint(c) {
    // 稳定序列化：键排序，避免 JSON.stringify 的键序差异造成假漂移
    const stable = JSON.stringify(c, Object.keys(c).sort());
    return sha256Short(stable);
}
function sha256Short(s) {
    // 稳定序列化后取哈希前 32 位：与 skills-lock 同思路，够用于漂移检测
    return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
}
/**
 * 按入参填充默认值并做类型校验（不执行脚本，只校验）。
 * 返回 { ok, params, problems }——params 已含默认值，可直接交给 runner。
 */
export function resolveParams(c, given) {
    const problems = [];
    const out = {};
    const specs = c.inputs ?? [];
    // 未知参数一律拒绝：静默丢弃会让"脚本明明收到了却没用上"这种事发生
    for (const k of Object.keys(given ?? {})) {
        if (!specs.some((s) => s.name === k))
            problems.push(`未知参数：${k}（契约未声明）`);
    }
    for (const s of specs) {
        const v = given?.[s.name];
        if (v === undefined || v === null || v === '') {
            if (s.required && s.default === undefined) {
                problems.push(`缺少必填参数：${s.name}`);
                continue;
            }
            if (s.default !== undefined)
                out[s.name] = s.default;
            continue;
        }
        if (s.type === 'number') {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n)) {
                problems.push(`参数 ${s.name} 不是有效数字：${JSON.stringify(v)}`);
                continue;
            }
            out[s.name] = n;
        }
        else if (s.type === 'boolean') {
            out[s.name] = v === true || v === 'true' || v === 1;
        }
        else {
            const str = String(v);
            if (s.type === 'path' && (str.includes('\0'))) {
                problems.push(`参数 ${s.name} 含非法字符`);
                continue;
            }
            if (s.type === 'enum' && s.values && !s.values.includes(str)) {
                problems.push(`参数 ${s.name} 取值 ${str} 不在允许范围 [${s.values.join(', ')}]`);
                continue;
            }
            out[s.name] = str;
        }
    }
    return { ok: problems.length === 0, params: out, problems };
}
