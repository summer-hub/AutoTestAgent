export function seed(db) {
    const t0 = Date.now();
    const LIBRARIES = [
        ['lottie_turbo', 'https://gitcode.com/CPF-ApplicationTPC/lottie_turbo', 'OpenHarmony Lottie 动画引擎（CPF-ApplicationTPC/lottie_turbo）：解析 AE 导出的 JSON 动画，声明式创建、并行化渲染、播放控制与事件监听'],
    ];
    const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const insertLib = db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, last_synced_at, created_at, updated_at)
    VALUES (@name, @repoUrl, @description, @currentVersion, 'active', @syncedAt, @createdAt, @updatedAt)`);
    db.transaction(() => {
        for (const [name, repoUrl, description] of LIBRARIES) {
            const t = now();
            insertLib.run({ name, repoUrl, description, currentVersion: 'v1.0.0', syncedAt: t, createdAt: t, updatedAt: t });
        }
    })();
    const t1 = now();
    const promptRows = [
        ['用例生成 Agent', '用例生成', '你是鸿蒙三方库测试用例生成 Agent。基于三方库 {library} 代码（版本 {version}）与仓库规则，生成结构化测试用例：1. 覆盖正向/边界/异常；2. 含前置条件/步骤/预期；3. 关注 ArkTS 约束与 API Level 兼容；4. 输出可导入用例库的结构。', 1],
        ['归因分析 Agent', '归因分析', '按粒度（单用例/单库/多库）分析执行失败根因：结合执行轨迹 {trace}、日志 {log}、设备 {device} 与 PR 变更 {prs}，输出根因与置信度。', 1],
        ['任务编排 Agent', '任务编排', '理解用户意图 {intent}，拆解为可执行子任务（拉取代码→编写用例→转脚本→执行→分析），维护任务状态机。', 1],
    ];
    const insPrompt = db.prepare(`INSERT OR IGNORE INTO prompts (name, role, content, variables, builtin, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)`);
    for (const [name, role, content, builtin] of promptRows) {
        const vars = (content.match(/\{(\w+)\}/g) || []).map((v) => v.slice(1, -1));
        insPrompt.run(name, role, content, JSON.stringify(vars), builtin, t1);
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
