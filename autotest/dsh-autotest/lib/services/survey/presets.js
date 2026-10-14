// survey 预设库（L1 层）：按库类别提供"开箱可用"的环境方案。
//
// 为什么需要预设（重构方案 §0.5.2）：348 个库逐个问 LLM 成本不可控，而同一类库的
// 依赖形态、构建方式、资源构造几乎同构。预设把"每类库怎么做环境准备"固化成数据，
// L1 匹配即得方案，AI 只在差异库上工作。
//
// 形态选择：**JSON 而不是 YAML**。工程没有 YAML 解析依赖（package.json 里只有
// xlsx/better-sqlite3 等），为一个配置文件引入解析器不划算；JSON 由 Node 原生支持，
// 且 preset 是程序消费的（不是人手写的长文），可读性损失可接受。
//
// 预设文件位置：assets/presets/<kind>/preset.json，随包分发（build-assets.mjs 复制）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * 预设根目录。
 *
 * Windows 坑（rules/windows-nodejs-pitfalls）：必须用 fileURLToPath，
 * 不能用 `new URL(import.meta.url).pathname`——后者在 Windows 返回 "/D:/..."
 * （前导斜杠），拼出的路径会变成 "D:\D:\..."（盘符翻倍）。R1 的 runner.ts 实测踩过。
 */
export function presetsRoot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // 本文件位于 <包根>/lib/services/survey（或 src/services/survey）→ 上溯三级到包根。
    // 曾写成四级（多退一级）导致预设全部找不到——全量分析页显示"无预设"，自检当场抓住。
    const pkgRoot = path.resolve(here, '../../..');
    const candidates = [
        path.join(pkgRoot, 'lib', 'assets', 'presets'), // 构建后
        path.join(pkgRoot, 'assets', 'presets'), // tsx 直接跑 src/
    ];
    for (const c of candidates)
        if (fs.existsSync(c))
            return c;
    return candidates[0];
}
/** 有哪些类别的预设可用（自检与「全量分析」页展示）。 */
export function availablePresetKinds() {
    const root = presetsRoot();
    if (!fs.existsSync(root))
        return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((k) => ['animation', 'network', 'storage', 'codec', 'ui_component', 'crypto'].includes(k));
}
/** 读取某类别的预设（不存在返回 null；JSON 坏则抛错——坏预设必须被发现，不能静默跳过）。 */
export function loadPreset(kind) {
    const file = path.join(presetsRoot(), kind, 'preset.json');
    if (!fs.existsSync(file))
        return null;
    const text = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(text);
    if (!p.kind || !Array.isArray(p.steps) || p.steps.length === 0) {
        throw new Error(`预设 ${kind} 不完整：缺 kind 或 steps（${file}）`);
    }
    return p;
}
/**
 * 把预设步骤转成画像步骤，并按 facts 填充差异参数。
 *
 * 关键点：`projectDir` 等运行时才知道的值用 `{{repoDir}}` 占位，
 * 由 runEnvProfile 在执行时替换——否则预设就得知道每个库 clone 到哪，
 * 而那是运行时事实，不该固化进预设。
 */
export function presetStepsToProfileSteps(preset, facts) {
    const steps = [];
    for (const s of preset.steps) {
        const params = { ...(s.params ?? {}) };
        // projectDir 统一占位（各脚本的入参名不同，这里按已知脚本名映射）
        if ('projectDir' in params && params.projectDir === '')
            params.projectDir = '{{repoDir}}';
        // 按 facts 做最小适配：构建目标决定构建哪一步
        if (s.scriptId === 'build_har' && facts.buildTarget === 'hap')
            continue; // 目标是 hap 就不建 har
        if (s.scriptId === 'build_hap' && facts.buildTarget === 'har')
            continue; // 反之亦然
        // 二进制依赖缺失时，把依赖获取步骤前置为必填
        if (s.scriptId === 'ohpm_install' && facts.hasBinary) {
            params.note = '工程含二进制依赖，安装后需确认 .so 产物齐备';
        }
        steps.push({ scriptId: s.scriptId, params, required: s.required !== false });
    }
    return steps;
}
/**
 * 按 facts 生成画像的 components 段。
 * 预设给骨架，facts 填实测值——这样同一类库的画像"结构相同、内容各异"。
 */
export function presetComponentsFor(preset, facts) {
    const c = { ...preset.components };
    // 二进制依赖：把实测到的 .so 清单并进去（预设只给"这类库通常有"，facts 给"这个库真有"）
    if (facts.hasBinary && facts.binaryKinds.length > 0) {
        c.binaryDeps = [
            ...(c.binaryDeps ?? []),
            ...facts.binaryKinds.map((k) => ({
                name: `detected:${k}`,
                abi: k.replace(/^so:/, ''),
                buildIfMissing: true,
                note: 'L0 扫描实测发现，需决策预编译 or 现编',
            })),
        ];
    }
    // 子模块
    if (facts.hasSubmodules) {
        c.submodules = [{ path: '(检测到 .gitmodules)', required: true }];
    }
    return c;
}
