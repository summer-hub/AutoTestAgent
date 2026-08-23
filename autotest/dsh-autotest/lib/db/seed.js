export function seed(db) {
    const t0 = Date.now();
    const LIB_NAMES = [
        'axios-ohos', 'lottie-ohos', 'charts-ohos', 'mmkv-ohos', 'eventbus-ohos', 'glide-ohos',
        'realm-ohos', 'zxing-ohos', 'ijkplayer-ohos', 'sqlite-ohos', 'okhttp-ohos', 'coil-ohos',
        'clock-ohos', 'media-ohos', 'bluetooth-ohos', 'crypto-ohos', 'network-ohos', 'image-ohos',
        'audio-ohos', 'video-ohos', 'gesture-ohos', 'animation-ohos', 'storage-ohos', 'database-ohos',
        'permission-ohos', 'notification-ohos', 'camera-ohos', 'sensor-ohos', 'location-ohos', 'maps-ohos',
        'lottie_turbo',
    ];
    const LIB_CATS = ['网络', '动画', '图表', '存储', '事件', '图片', '数据库', '扫码', '播放器', 'SQLite', 'HTTP', '图片加载', '时钟', '多媒体', '蓝牙', '加密', '网络层', '图片处理', '音频', '视频', '手势', '动画引擎', '存储层', '数据库', '权限', '通知', '相机', '传感器', '定位', '地图', '动画引擎'];
    const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const insertLib = db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, last_synced_at, created_at, updated_at)
    VALUES (@name, @repoUrl, @description, @currentVersion, 'active', @syncedAt, @createdAt, @updatedAt)`);
    const totalLibs = 400;
    db.transaction(() => {
        for (let li = 0; li < totalLibs; li++) {
            const base = LIB_NAMES[li % LIB_NAMES.length];
            const cat = LIB_CATS[li % LIB_CATS.length];
            const name = li < LIB_NAMES.length ? base : `${base}-${String(li).padStart(3, '0')}`;
            const major = 1 + (li % 9);
            const version = `v${major}.${li % 20}.${li % 5}`;
            const repoUrl = name === 'lottie_turbo'
                ? 'https://gitcode.com/CPF-ApplicationTPC/lottie_turbo'
                : `https://gitee.com/openharmony-tpc/${name}`;
            const description = name === 'lottie_turbo'
                ? 'OpenHarmony Lottie 动画引擎（CPF-ApplicationTPC/lottie_turbo）：解析 AE 导出的 JSON 动画，声明式创建、并行化渲染、播放控制与事件监听'
                : `${cat}类鸿蒙三方库（OpenHarmony 兼容移植），提供${cat}相关能力封装`;
            const t = now();
            const libRes = insertLib.run({ name, repoUrl, description, currentVersion: version, syncedAt: t, createdAt: t, updatedAt: t });
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
    console.log(`✅ dsh-autotest 种子完成：${totalLibs} 个三方库注册（不含虚假用例/任务/设备），耗时 ${Date.now() - t0}ms`);
}
