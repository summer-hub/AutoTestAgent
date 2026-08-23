// 种子数据（插件版）：仅注册真实三方库（repo_url 指向真实仓库）+ Prompt / 模型 / 配置。
// 用例、任务、设备一律由真实功能产生（AI 编写 / Excel 导入 / hdc 识别），不再灌虚假数据。
import type Database from 'better-sqlite3';

export function seed(db: Database.Database): void {
  const t0 = Date.now();

  const LIBRARIES: Array<[string, string, string]> = [
    ['lottie_turbo', 'https://gitcode.com/CPF-ApplicationTPC/lottie_turbo', 'OpenHarmony Lottie 动画引擎（CPF-ApplicationTPC/lottie_turbo）：解析 AE 导出的 JSON 动画，声明式创建、并行化渲染、播放控制与事件监听'],
  ];
  const now = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

  const insertLib = db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, last_synced_at, created_at, updated_at)
    VALUES (@name, @repoUrl, @description, @currentVersion, 'active', @syncedAt, @createdAt, @updatedAt)`);

  db.transaction(() => {
    for (const [name, repoUrl, description] of LIBRARIES) {
      const t = now();
      insertLib.run({ name, repoUrl, description, currentVersion: 'v1.0.0', syncedAt: t, createdAt: t, updatedAt: t });
    }
  })();

  const t1 = now();

  const promptRows: Array<[string, string, string, string, number]> = [
    ['用例生成 Agent', '用例生成',
      '你是鸿蒙三方库 UI 测试用例设计 Agent。基于已下载仓库的真实工程代码设计用例：\n1. 解析 bundleName / mainAbility 与 entry/src/main/ets/pages 真实页面与控件；\n2. 操作步骤必须是真实界面可触发的动作（打开应用 / 点击 / 输入 / 滑动 / 等待 / 验证文本或动画），严禁臆造；\n3. 预期结果写明具体动画（Lottie json 名）、UI 表现与 hilog 日志；\n4. 来源固定为 AI 生成；\n5. 输出 JSON 数组：{ name, precondition, steps[], expected }，覆盖正向/边界/异常。只输出 JSON。',
      'autotest-case-author：真实工程驱动 —— 解析 bundleName/mainAbility 与 pages，步骤可触发，预期落具体动画与日志。', 1],
    ['归因分析 Agent', '归因分析', '按粒度（单用例/单库/多库）分析执行失败根因：结合执行轨迹 {trace}、日志 {log}、设备 {device} 与 PR 变更 {prs}，输出根因与置信度。', '', 1],
    ['任务编排 Agent', '任务编排', '理解用户意图 {intent}，拆解为可执行子任务（拉取代码→编写用例→转脚本→执行→分析），维护任务状态机。', '', 1],
  ];
  const insPrompt = db.prepare(`INSERT OR IGNORE INTO prompts (name, role, content, skill, variables, builtin, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`);
  for (const [name, role, content, skill, builtin] of promptRows) {
    const vars = (content.match(/\{(\w+)\}/g) || []).map((v) => v.slice(1, -1));
    insPrompt.run(name, role, content, skill, JSON.stringify(vars), builtin, t1);
  }

  db.prepare(`INSERT OR IGNORE INTO models (name, provider, base_url, model_id, api_key, is_default, created_at, updated_at) VALUES
   ('deepseek-chat', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', '', 1, @t, @t),
   ('deepseek-reasoner', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-reasoner', '', 0, @t, @t),
   ('ollama 本地', 'ollama', 'http://localhost:11434/v1', 'qwen2.5:7b', '', 0, @t, @t)`).run({ t: t1 });

  db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
   ('app.workspace', '"D:\\autotest\\workspace"', @t),
   ('agent.defaultModel', '"deepseek-chat"', @t),
   ('data.redisCache', 'false', @t),
   ('device.execEngine', '"hdc"', @t),
   ('exec.scriptMode', '"script"', @t)`).run({ t: t1 });

  console.log(`✅ dsh-autotest 种子完成：${LIBRARIES.length} 个三方库注册（不含虚假用例/任务/设备），耗时 ${Date.now() - t0}ms`);
}
