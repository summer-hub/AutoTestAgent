// 种子数据（插件版）：仅注册真实三方库（repo_url 指向真实仓库）+ Prompt / 模型 / 配置。
// 用例、任务、设备一律由真实功能产生（AI 编写 / Excel 导入 / hdc 识别），不再灌虚假数据。
import { getDb, now, transaction } from './connection.js';

export async function seed(): Promise<void> {
  const t0 = Date.now();

  const LIBRARIES: Array<[string, string, string]> = [
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

  // 内置「用例生成 Agent」Prompt v2：真实可操作 / 逻辑合理 / 预期明确清晰 + 遍历数据驱动 + 库类别适配
  const CASE_GEN_V2_CONTENT = `你是鸿蒙三方库 UI 测试用例设计 Agent（HarmonyOS/OpenHarmony）。
【设计原则】以「真实可操作、用例逻辑合理、预期结果明确清晰」为准绳：
1. 真实可操作——所有步骤必须基于给定上下文中真实存在的页面与控件（仓库工程解析或真机遍历 dump），严禁臆造按钮/菜单/跳转；
2. 逻辑合理——步骤顺序符合真实用户操作路径，前置条件完整，正向/边界/异常场景覆盖且有区分度，不堆砌重复用例；
3. 预期结果明确清晰——具体到控件文本、动画名（如 Lottie json）、hilog 日志内容等可观察证据，禁止「显示正常」「工作正常」式空泛描述。
【库类别适配】先判断库的类别（动画渲染/网络请求/UI 组件/数据存储等），按类别选择验证手段：
- 动画类：验证播放/暂停/进度/循环与帧表现；
- 网络类：验证请求成功/失败/超时回调与 hilog 输出；
- UI 组件类：验证属性设置、事件回调、状态切换；
- 其他类别按库简介自行推导最合理的验证手段，并在用例中说明依据。
【输出】JSON 数组：{ name, precondition, steps[], expected }，来源固定为 AI 生成。只输出 JSON。`;
  const CASE_GEN_V2_SKILL = 'autotest-case-author v2：真实工程/真机遍历双驱动——控件必须来自真实数据；按库类别（动画/网络/组件/存储）适配验证手段；预期落具体动画、文本与 hilog 日志；生成后自审修订（真实可操作/逻辑合理/预期清晰）。';

  const promptRows: Array<[string, string, string, string, number]> = [
    ['用例生成 Agent', '用例生成', CASE_GEN_V2_CONTENT, CASE_GEN_V2_SKILL, 1],
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

  await db.prepare(`INSERT IGNORE INTO settings (\`key\`, value, updated_at) VALUES
   ('app.workspace', '"D:\\autotest\\workspace"', @t),
   ('agent.defaultModel', '""', @t),
   ('data.redisCache', 'false', @t),
   ('device.execEngine', '"hdc"', @t),
   ('exec.scriptMode', '"script"', @t)`).run({ t: t1 });

  console.log(`✅ dsh-autotest 种子完成：${LIBRARIES.length} 个三方库注册（不含虚假用例/任务/设备），耗时 ${Date.now() - t0}ms`);
}
