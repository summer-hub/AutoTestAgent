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
    const SOURCES = [
        ['老库存量', 0.30], ['新需求引入', 0.35], ['问题单跟踪', 0.20], ['AI 生成', 0.15],
    ];
    const CASE_STATUSES = [
        ['通过', 0.82], ['失败', 0.06], ['待确认', 0.06], ['未执行', 0.06],
    ];
    const STEPS_POOL = [
        '初始化测试环境并安装应用', '打开应用主界面，等待首帧渲染完成', '输入测试数据并确认输入正确',
        '触发核心操作，观察界面响应', '验证界面状态与预期一致', '切换后台再切回，验证状态保持',
        '检查边界条件与异常输入', '清理测试数据并记录结果',
    ];
    const VERB_POOL = ['创建', '更新', '读取', '删除', '加载', '渲染', '并发', '缓存', '序列化', '校验', '重试', '超时'];
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function weighted(items) {
        const r = Math.random();
        let acc = 0;
        for (const [v, w] of items) {
            acc += w;
            if (r <= acc)
                return v;
        }
        return items[0][0];
    }
    const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const insertLib = db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, last_synced_at, created_at, updated_at)
    VALUES (@name, @repoUrl, @description, @currentVersion, 'active', @syncedAt, @createdAt, @updatedAt)`);
    const insertCase = db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, created_at, updated_at)
    VALUES (@libraryId, @caseNo, @name, @source, @precondition, @steps, @expected, @status, @scriptStatus, @currentVersion, @createdAt, @updatedAt)`);
    const insertVer = db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
    VALUES (@caseId, @version, @snapshot, @changeNote, @author, @authorType, @createdAt)`);
    const totalLibs = 400;
    let totalCases = 0;
    let totalVersions = 0;
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
            const libraryId = Number(libRes.lastInsertRowid);
            const caseCount = 100 + (li % 30);
            for (let ci = 0; ci < caseCount; ci++) {
                const verb = pick(VERB_POOL);
                const src = weighted(SOURCES);
                const status = weighted(CASE_STATUSES);
                const scriptBound = Math.random() < 0.85;
                const verCount = Math.random() < 0.55 ? 2 : 1;
                const prefix = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'LIB';
                const caseNo = `C-${prefix}-${String(ci + 1).padStart(3, '0')}`;
                const caseName = `${verb}${cat}功能-场景${ci + 1}`;
                const steps = Array.from({ length: 3 + (ci % 5) }, (_, s) => `${s + 1}. ${pick(STEPS_POOL)}`);
                const expected = `${cat}功能正常，无异常日志，界面状态符合预期`;
                const createdAt = now();
                const updatedAt = verCount > 1 ? now() : createdAt;
                const caseRow = {
                    libraryId, caseNo, name: caseName, source: src,
                    precondition: `前置：应用已安装，库版本 ${version}`,
                    steps: JSON.stringify(steps), expected,
                    status, scriptStatus: scriptBound ? '已绑定' : '未绑定',
                    currentVersion: verCount, createdAt, updatedAt,
                };
                const caseRes = insertCase.run(caseRow);
                const caseId = Number(caseRes.lastInsertRowid);
                totalCases++;
                const snapshotV1 = { ...caseRow, id: caseId, libraryId, caseNo, name: caseName, source: src, precondition: caseRow.precondition, steps, expected, status, scriptStatus: caseRow.scriptStatus, currentVersion: 1, createdAt, updatedAt: createdAt };
                insertVer.run({ caseId, version: 1, snapshot: JSON.stringify(snapshotV1), changeNote: '初始创建：基于三方库代码与仓库规则生成，覆盖正向/边界/异常场景。', author: 'AI 用例生成 Agent', authorType: 'ai', createdAt });
                totalVersions++;
                if (verCount > 1) {
                    const snapshotV2 = { ...snapshotV1, currentVersion: 2, updatedAt, name: caseName + '（V2）' };
                    insertVer.run({ caseId, version: 2, snapshot: JSON.stringify(snapshotV2), changeNote: `更新点：随 ${version} 版本 PR 变更迭代；新增边界场景，修正预期结果。版本自动递增 V1→V2。`, author: 'AI 用例更新 Agent', authorType: 'ai', createdAt: updatedAt });
                    totalVersions++;
                }
            }
        }
    })();
    const t1 = now();
    db.prepare(`INSERT OR IGNORE INTO devices (serial, model, os_version, status, battery, memory_usage, last_seen_at, created_at) VALUES
   ('HDC-7F3A','Mate 60 Pro','HarmonyOS 5.0.0','online',86,62,@t,@t),
   ('HDC-8B22','P40 Pro','OpenHarmony 5.0.2','online',71,55,@t,@t),
   ('HDC-5C01','Nova 12','HarmonyOS 4.2','online',93,41,@t,@t),
   ('HDC-2B11','Mate 60 Pro','HarmonyOS 5.0.0','history',NULL,NULL,@t,@t)`).run({ t: t1 });
    db.prepare(`INSERT OR IGNORE INTO plans (plan_no, name, type, cron, scope, device_ids, status, fail_policy, last_run_at, created_at, updated_at) VALUES
   ('P-1001','clock-ohos 定时回归','scheduled','0 2 * * *','{"libraryIds":[12],"caseIds":[]}','[1]','done','continue',@t,@t,@t),
   ('P-1002','全量执行 · 夜间批次','full',NULL,'{"libraryIds":[],"caseIds":[]}','[1,2,3]','done','continue',@t,@t,@t),
   ('P-1003','交互类库组批量执行','batch',NULL,'{"libraryIds":[1,2,12],"caseIds":[]}','[1,2]','done','continue',@t,@t,@t)`).run({ t: t1 });
    db.prepare(`INSERT OR IGNORE INTO tasks (task_no, type, title, library_id, input, status, progress, result_summary, created_at, updated_at) VALUES
   ('T-2001','pull_repo','拉取仓库代码','1','拉取 axios-ohos 最新代码','done',100,'已拉取 v1.13.0，解析 12 个变更点',@t,@t),
   ('T-2002','write_cases','编写测试用例','2','为 lottie-ohos 动画渲染模块编写测试用例','running',72,'AI 已生成 36 条用例 · V2 草案',@t,@t),
   ('T-2003','to_script','用例转自动化脚本','5','将 mmkv-ohos 用例转为自动化脚本','running',78,'87/112 条已转换',@t,@t)`).run({ t: t1 });
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
   ('device.execEngine', '"hdc"', @t)`).run({ t: t1 });
    console.log(`✅ dsh-autotest 种子完成：${totalLibs} 库 / ${totalCases} 用例 / ${totalVersions} 版本记录，耗时 ${Date.now() - t0}ms`);
}
