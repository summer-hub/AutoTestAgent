// 种子数据（插件版）：仅注册真实三方库（repo_url 指向真实仓库）+ Prompt / 模型 / 配置。
// 用例、任务、设备一律由真实功能产生（AI 编写 / Excel 导入 / hdc 识别），不再灌虚假数据。
import { getDb, now, transaction } from './connection.js';
export async function seed() {
    const t0 = Date.now();
    const LIBRARIES = [
        ['lottie_turbo', 'https://gitcode.com/CPF-ApplicationTPC/lottie_turbo', 'OpenHarmony Lottie 动画引擎（CPF-ApplicationTPC/lottie_turbo）：解析 AE 导出的 JSON 动画，声明式创建、并行化渲染、播放控制与事件监听'],
    ];
    const db = getDb();
    const insertLib = db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, last_synced_at, created_at, updated_at)
    VALUES (@name, @repoUrl, @description, @currentVersion, 'active', @syncedAt, @createdAt, @updatedAt)`);
    await transaction(async () => {
        for (const [name, repoUrl, description] of LIBRARIES) {
            const t = now();
            await insertLib.run({ name, repoUrl, description, currentVersion: 'v1.0.0', syncedAt: t, createdAt: t, updatedAt: t });
        }
    });
    const t1 = now();
    // 内置「用例生成 Agent」Prompt v3：
    //   · 技能绑定从 autotest-case-author 换成 ohos-library-testcase-pipeline（项目内 skills/ 目录）
    //   · 把"可机器校验判据 / 四类场景适用性 / 不臆造控件"写进正文，而不只写在技能里
    // 注意：正文与 skill 必须与 connection.ts 的 CASE_GEN_V3_* 保持一致 ——
    //      老库靠 upgradeBuiltinPrompts() 升到 v3，新库靠这里播种，两边不一致就会出现"新装与升级不同"。
    const CASE_GEN_V3_CONTENT = `你是鸿蒙三方库 UI 测试用例设计 Agent（HarmonyOS/OpenHarmony）。
【必须遵循的技能】本平台生成手工测试用例一律使用技能 ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md，按需读取其 references/）：它给出了四类场景的适用性依据、可机器校验判据的取值域、可测性 A/B/C/D 判定与 demo 最小改造规范。已废弃的 autotest-case-author 不再使用。
【设计原则】以「真实可操作、逻辑合理、预期可机器校验」为准绳：
1. 真实可操作——所有步骤必须基于给定上下文中真实存在的页面与控件（仓库工程解析或真机遍历 dump），严禁臆造按钮/菜单/跳转；控件文本要逐字一致；
2. 逻辑合理——步骤顺序符合真实用户操作路径，前置条件完整；按四类场景展开（正向/空值/边界异常/大数据），**不适用就写明理由，不硬造**；
3. 预期可机器校验（硬门槛）——每条用例必须给出可核对的判据：界面出现/消失的具体控件文本、控件文本等于/包含某值（含错误码）、勾选状态、hilog 关键字、无崩溃、截图差异之一。禁止「显示正常」「工作正常」「符合预期」这类无法核对的措辞，也禁止恒真断言。
【库类别适配】先判断库的类别（动画渲染/网络请求/UI 组件/数据存储等），按类别选择验证手段：
- 动画类：验证播放/暂停/进度/循环与帧表现；
- 网络类：验证请求成功/失败/超时回调与 hilog 输出；
- UI 组件类：验证属性设置、事件回调、状态切换；
- 其他类别按库简介自行推导最合理的验证手段，并在用例中说明依据。
【输出】JSON 数组：{ name, precondition, steps[], expected, oracles[] }，来源固定为 AI 生成。只输出 JSON。`;
    const CASE_GEN_V3_SKILL = [
        '【必须使用】ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md）。',
        '本平台"生成手工测试用例"一律走该技能；已废弃的 autotest-case-author 禁止使用（该技能只剩跳转说明）。',
        '三条硬性纪律（违反即作废）：',
        '① 假通过 0——每条用例必须有可机器校验判据（界面文本/控件文本/勾选状态/hilog 关键字/无崩溃/截图差异），禁止"正常/成功/符合预期"式措辞与恒真断言；',
        '② 不虚报覆盖——demo 里真实调用过 且 至少一条负向用例（空值或边界异常）才判"已覆盖"；只有正向只判部分覆盖，仅单元测试调用也只判部分覆盖，纯类型声明判不可测；',
        '③ 不臆造控件与结论——步骤引用的控件文本必须逐字来自真机 dump（devecocli ui layout）或工程源码；拿不到证据就写"未获取"，绝不编造。',
    ].join('\n');
    // 内置「用例优化 Agent」Prompt v2：技能绑定同样改为 ohos-library-testcase-pipeline。
    // 优化就是在同一套规则下补用例（S4 场景适用性 / S5 demo 改造 / S6 判据门槛），
    // 绑两套规则会让"什么算合格用例"走形；v1 绑的 autotest-case-optimizer 在 skills/ 里并不存在（悬空引用）。
    // 文本与 connection.ts 的 CASE_OPT_V2_* 保持一致。
    const CASE_OPT_V2_CONTENT = '你是鸿蒙三方库测试用例优化 Agent。在保持原用例测试意图与覆盖目标不变的前提下提升质量。\n【必须遵循的技能】与用例生成同一套规则：ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md）—— 补缺按 S4 的场景适用性（不适用要写理由，不硬造），判据按 S6 的取值域（可机器校验），需要改 demo 的按 S5 的规范（副本 + 最小改造 + 构建 + 真机验证）。\n【优化准绳】\n1. 真实可操作——步骤引用的控件必须来自给定上下文（页面源码/真机遍历控件清单），删除或修正臆造的按钮与跳转；\n2. 逻辑合理——补全前置条件，理顺操作顺序，拆分过长的组合步骤，去除重复；新增用例只补真正的缺口（接口无用例 / 缺负向场景），不堆数量；\n3. 预期可机器校验（硬门槛）——每条用例必须有可核对的判据（界面文本/控件文本/勾选状态/hilog 关键字/无崩溃/截图差异），禁止「显示正常」「工作正常」「符合预期」式措辞与恒真断言；内容超一屏时补「向上滑动查看输出区域」步骤；\n4. 输出 JSON：{ name, precondition, steps[], expected, oracles[] }。只输出 JSON，不要解释。';
    const CASE_OPT_V2_SKILL = [
        '【必须使用】ohos-library-testcase-pipeline（仓库内 skills/ohos-library-testcase-pipeline/SKILL.md）——与用例生成同一套规则。',
        '已废弃的 autotest-case-optimizer 不再使用（该名字在 skills/ 目录里没有对应文件，属悬空引用）。',
        '三条硬性纪律（与用例生成一致）：① 假通过 0——每条用例都要有可机器校验判据，禁止含糊措辞与恒真断言；',
        '② 不虚报覆盖——只补真缺口，demo 真实调用 + 至少一条负向才算已覆盖；',
        '③ 不臆造控件——步骤里的控件文本必须逐字来自真机 dump 或工程源码。',
        '补缺时按 S4 判定场景适用性；需要改 demo 按 S5（副本 + 最小改造 + 构建 + 真机验证）。',
    ].join('\n');
    // 内置「脚本生成 Agent」Prompt v2：把手写用例转 Hypium 自动化脚本这一步也绑成技能。
    // 这一阶段的生成是**确定性模板**（不花 token），提示词只描述约定与纪律，
    // 供人在设置页查看/调整，以及被 agent_bindings 覆盖时作对照。
    const SCRIPT_GEN_CONTENT = [
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
    const promptRows = [
        ['用例生成 Agent', '用例生成', CASE_GEN_V3_CONTENT, CASE_GEN_V3_SKILL, 1],
        ['用例优化 Agent', '用例优化', CASE_OPT_V2_CONTENT, CASE_OPT_V2_SKILL, 1],
        ['脚本生成 Agent', '脚本生成', SCRIPT_GEN_CONTENT, SCRIPT_GEN_SKILL, 1],
        // demo 侧三阶段：规划场景 → 量化 demo 覆盖 → 补 demo 代码（与 connection.ts 的 DEMO_STAGE_PROMPTS 对应）
        ['demo 场景规划 Agent', 'demo 解析',
            '把三方库的接口规格转成 Demo 测试场景清单：正向（常规用法）+ 反向（空值/边界/异常），每个场景写清名称、描述、功能点、关键体验指标、用户期望与设计关注点。只依据接口规格文档与真实源码，不臆造接口。',
            '【必须使用】ohos-demo-scenario-generator（仓库内 skills/ohos-demo-scenario-generator/SKILL.md）：产出「库名+Demo场景.md」，作为 demo 覆盖分析与补代码的输入。', 1],
        ['demo 覆盖分析 Agent', '覆盖矩阵',
            '对比 Demo 场景文档与 entry 目录现有代码，量化"规划的场景有多少真的被 demo 覆盖"，逐条给出已覆盖/部分覆盖/未覆盖与差距证据，并给出可执行的补充优先级。没有证据的结论不要写。',
            '【必须使用】ohos-demo-coverage-analyzer（仓库内 skills/ohos-demo-coverage-analyzer/SKILL.md）：它把覆盖度量化成可核对的比例与清单，与本平台 P3 覆盖矩阵（接口维度）互补：一个看接口覆盖，一个看场景/代码覆盖。', 1],
        ['demo 代码生成 Agent', 'demo 补丁',
            '按场景描述生成可编译运行的 ArkTS demo 代码：每个 Demo 一个独立 .ets 页面，主页统一导航，含 hilog 日志、错误处理与必要注释。生成的代码必须真机验证（构建 + 跑通），未验证要写明。',
            '【必须使用】ohos-demo-code-generator（仓库内 skills/ohos-demo-code-generator/SKILL.md）：它规定了页面命名、导航接入、权限适配与代码质量检查；注意它依赖 knowledge-base MCP 查 HarmonyOS API 签名（不可用时如实降级）。', 1],
        ['归因分析 Agent', '归因分析', '按粒度（单用例/单库/多库）分析执行失败根因：结合执行轨迹 {trace}、日志 {log}、设备 {device} 与 PR 变更 {prs}，输出根因与置信度。', '', 1],
        ['任务编排 Agent', '任务编排', '理解用户意图 {intent}，拆解为可执行子任务（拉取代码→编写用例→转脚本→执行→分析），维护任务状态机。', '', 1],
    ];
    const insPrompt = db.prepare(`INSERT IGNORE INTO prompts (name, role, content, skill, variables, builtin, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`);
    for (const [name, role, content, skill, builtin] of promptRows) {
        const vars = (content.match(/\{(\w+)\}/g) || []).map((v) => v.slice(1, -1));
        await insPrompt.run(name, role, content, skill, JSON.stringify(vars), builtin, t1);
    }
    await db.prepare(`INSERT IGNORE INTO models (name, provider, base_url, model_id, api_key, is_default, created_at, updated_at) VALUES
   ('deepseek-chat', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', '', 1, @t, @t),
   ('deepseek-reasoner', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-reasoner', '', 0, @t, @t),
   ('ollama 本地', 'ollama', 'http://localhost:11434/v1', 'qwen2.5:7b', '', 0, @t, @t)`).run({ t: t1 });
    // 注意：这里**不能**写 app.workspace。
    // 历史上种子把它硬编码成开发机路径（D:\autotest\workspace），后果有两层：
    //   1) 换机器/换系统后工作区指向一个无效目录；
    //   2) workspaceConfigured() 返回 true，"未配置工作区"的告警被架空（治理逻辑失效）。
    // 工作区必须留空，由使用者在「系统配置」里显式设定；未设置时回退到 <启动目录>/workspace 并给出提示。
    await db.prepare(`INSERT IGNORE INTO settings (\`key\`, value, updated_at) VALUES
   ('agent.defaultModel', '""', @t),
   ('data.redisCache', 'false', @t)`).run({ t: t1 });
    console.log(`✅ dsh-autotest 种子完成：${LIBRARIES.length} 个三方库注册（不含虚假用例/任务/设备），耗时 ${Date.now() - t0}ms`);
}
