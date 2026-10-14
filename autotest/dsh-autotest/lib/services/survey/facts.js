// survey L0 层：从仓库静态扫描出的**客观事实**与**库类别判定**。
//
// 为什么必须是纯函数 + 零 LLM（全量规模化的核心，见重构方案 §0.5）：
//   348 个库逐个问 LLM 成本不可控（约 350 万 tokens 输入），而同一类库的事实高度同构。
//   所以先用确定性采集把客观事实拿到手，LLM 只在差异库上工作（R3 的 L2）。
//   纯函数化是为了让 verify-survey 能离线覆盖——"为什么这个库被判成 animation"
//   必须可逐条核对，不能是模型的一句"看起来像"。
//
// 本文件不碰磁盘：输入是 scanRepo() 采来的原始材料，输出是结构化事实。
// 分类规则是**有序**的（先匹配到的赢），顺序本身是产品决策：
// 网络/存储这类有强信号词的放前面，"组件"这类弱信号放后面，避免误判。
import path from 'node:path';
/** 库类别（preset 的目录名与此一一对应）。 */
export const LIBRARY_KINDS = ['animation', 'network', 'storage', 'codec', 'ui_component', 'crypto', 'unknown'];
export const KIND_LABEL = {
    animation: '动画渲染', network: '网络请求', storage: '数据存储',
    codec: '编解码', ui_component: 'UI 组件', crypto: '加解密', unknown: '未识别',
};
/** 分类规则：按顺序匹配，第一个命中的赢。weight 用于同类多信号时给更高置信度。 */
const CLASSIFY_RULES = [
    {
        kind: 'animation',
        strong: [
            /lottie/i, /bodymovin/i, /\banimation\b/i, /\banimator\b/i, /逐帧|补间|动效|动画/,
            /svg.*animat|animat.*svg/i, /ripple|shimmer|skeleton/i,
        ],
        // 多个弱正则：classifyKind 的"弱信号叠加"要求 ≥2 个**不同**正则命中，
        // 只写一个正则时这条路径永远走不通（自检当场抓住过）。
        weak: [/帧|frame\s*rate|keyframe|easing|缓动/i, /bezier|curve|path\s*morph|transform/i],
    },
    {
        kind: 'network',
        strong: [
            /\bhttp\b.*client|retrofit|okhttp|axios|fetch|websocket|netty|grpc|ktor/i,
            /网络请求|接口请求|下载文件|上传文件|\bsocket\b/i,
        ],
        weak: [/tcp|udp|dns|proxy|代理/i],
    },
    {
        kind: 'storage',
        strong: [
            /\bsqlite\b|\bmmkv\b|\brealm\b|room\b|preferences|datastore|indexeddb|leveldb|rocksdb/i,
            /数据库|本地存储|持久化|缓存.*(存储|落盘)/i,
        ],
        weak: [/cache|缓存|kv|key.*value/i],
    },
    {
        kind: 'codec',
        strong: [
            /ffmpeg|libpng|libjpeg|libwebp|libyuv|openh264|x264|mediacodec|编解码|转码/i,
            /\b(png|jpe?g|webp|gif|bmp|heic|avif)\b.*(encode|decode|compress)/i,
        ],
        weak: [/compress|压缩|decode|encode|像素|bitmap/i],
    },
    {
        kind: 'crypto',
        strong: [/\b(aes|rsa|sha\d|md5|hmac|ecdsa|ed25519)\b.*(encrypt|decrypt|sign|digest)|加密|解密|签名验签/i],
        weak: [/hash|摘要|随机数|secure/i],
    },
    {
        // 放最后：UI 组件的信号最泛（"组件""控件"到处都是），
        // 若放前面会把动画库/网络库误吞成组件库。
        kind: 'ui_component',
        strong: [
            /recyclerview|listview|viewpager|swiper|tablayout|bottomnav|dialog|toast|snackbar|chip|badge/i,
            /\bui\s*component|自定义控件|自定义组件|widget/i,
        ],
        weak: [/component|控件|组件|layout|button|text/i],
    },
];
/** 二进制文件后缀 → ABI/类型归类。 */
function binaryKindOf(rel) {
    if (/\.so$/i.test(rel)) {
        // ABI 目录名要按"长模式优先"匹配：否则 libarm64-v8a 会被 arm64 先吃掉，
        // 归成 so:arm64 而不是 so:arm64-v8a（ABI 信息丢失，二进制依赖决策会出错）。
        const m = /(arm64-v8a|armeabi-v7a|armeabi|x86_64|x64|riscv64|riscv)/i.exec(rel);
        return m ? `so:${m[1].toLowerCase()}` : 'so:unknown-abi';
    }
    if (/\.a$/i.test(rel))
        return 'static:a';
    if (/\.lib$/i.test(rel))
        return 'static:lib';
    return 'binary';
}
/** 从文件列表里找测试资源候选（确定性启发式，命中即登记，不猜内容）。 */
function scanResourceCandidates(scan) {
    const out = [];
    const seen = new Set();
    const push = (kind, ref, reason) => {
        if (seen.has(ref))
            return;
        seen.add(ref);
        out.push({ kind, ref, origin: 'repo_scan', reason, sizeBytes: 0 });
    };
    for (const f of scan.files) {
        const lower = f.toLowerCase();
        const base = path.basename(lower);
        // 动画 json：lottie/bodymovin 的 json 动画。判据是"在 demo/example/sample 目录下的 json"
        // 或文件名含 animation/lottie 的 json——不读内容判断（那是 LLM 的事）。
        if (/\.json$/.test(base) && /(demo|example|sample|test|fixture|resource|raw|assets)/.test(lower)) {
            if (/lottie|animat|motion|frame/.test(lower)) {
                push('animation_json', f, 'json 位于 demo/example 目录且路径含动画特征');
            }
        }
        // 图片资源：测试截图对比的候选
        if (/\.(png|jpe?g|webp|bmp|gif)$/.test(base) && /(resource|assets|raw|media|image|baseline)/.test(lower)) {
            push('image', f, '图片位于资源目录（截图对比/基线候选）');
        }
        // 音视频：媒体类库的输入素材
        if (/\.(mp4|mkv|webm|mp3|aac|wav|h264|hevc)$/.test(base) && /(resource|assets|raw|media|video)/.test(lower)) {
            push('media', f, '音视频素材（媒体类库的输入）');
        }
        // 证书与密钥：网络/安全类库的必备资源
        if (/\.(pem|crt|cer|key|p12|pfx|jks|bks)$/.test(base)) {
            push('ca_cert', f, '证书/密钥文件（CA 构造候选）');
        }
        // 服务端 fixture：mock server 的响应样本
        if (/\.(json|xml|txt|html)$/.test(base) && /(fixture|mock|stub|server|response)/.test(lower)) {
            push('server_fixture', f, '服务端响应样本（mock server 候选）');
        }
        // 数据库 fixture
        if (/\.(sql|db|sqlite3?)$/.test(base)) {
            push('db_fixture', f, '数据库文件（存储类库的输入）');
        }
        // 配置模板
        if (/\.(json5|json|properties|cfg|conf|config|toml|yaml|yml)$/.test(base) && /(config|profile|setting)/.test(lower)) {
            push('config', f, '配置文件（环境画像的 file_configs 候选）');
        }
    }
    return out;
}
/** 从 README 里抽取结构化情报（依赖/构建命令/前置条件/已知问题/样本资源）。 */
export function extractReadmeIntel(readme) {
    const out = [];
    const lines = String(readme ?? '').split(/\r?\n/);
    const push = (kind, text, line) => {
        const t = text.trim();
        if (t.length < 6 || t.length > 400)
            return; // 太短的没信息，太长的多半是整段说明
        out.push({ kind, text: t, line });
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lower = line.toLowerCase();
        // 构建命令：ohpm install / hvigorw / deveco-cli。
        // ⚠️ 不能只写 deveco：'DevEco Studio 5.0' 是**版本要求**不是命令，
        //    宽泛匹配会把依赖要求误吞成 build_cmd（自检当场抓住过）。
        if (/(ohpm\s+install|hvigorw|hvigor\s+assemble|deveco-cli|devecocli|assembleHar|assembleHap)/i.test(line)) {
            push('build_cmd', line, i + 1);
        }
        // 依赖：OpenSSL / CMake / NDK / SDK 版本要求（必须同时出现"依赖名"与"版本号/比较符"）
        else if (/(openssl|cmake|ndk|sdk|api\s*level|依赖|dependenc|prerequisite|require[sd]?)/i.test(line)
            && /(>=|≤|>=|version|版本|\d+\.\d+)/i.test(line)) {
            push('dependency', line, i + 1);
        }
        // 前置条件：需要真机/账号/外部服务。**中英双语**都要认——
        // 英文 README 只说 "needs a real device"，只匹配中文会整条漏掉。
        else if (/(需要|必须|前提|before|note|注意|⚠|warning|requires?)/i.test(line)
            && /(真机|设备|账号|token|key|服务|网络|权限|环境|device|account|server|network|permission|credential|internet)/i.test(line)) {
            push('prerequisite', line, i + 1);
        }
        // 已知问题
        else if (/(known issue|已知问题|限制|limitation|not support|不支持|暂不支持)/i.test(lower)) {
            push('known_issue', line, i + 1);
        }
        // 样本资源位置
        else if (/(sample|示例|样例|example|demo.*(资源|文件)|test.*(资源|文件))/i.test(lower)
            && /\.(json|png|jpg|mp4|pem|sql)/i.test(line)) {
            push('sample_asset', line, i + 1);
        }
    }
    return out.slice(0, 60);
}
/**
 * 判定库类别（纯函数，可逐条核对）。
 *
 * 返回 reason 是为了让"为什么判成 animation"可解释——分类结果是 preset 选择的依据，
 * 不可解释的分类等于让人盲信。
 */
export function classifyKind(scan) {
    // 语料 = 库名 + README + 依赖名 + 关键路径。不含文件内容（那是 LLM 的活）。
    const depNames = Object.keys(scan.ohPackage?.dependencies ?? {});
    const pathHints = scan.files.filter((f) => /lottie|animat|network|http|storage|sqlite|codec|crypto/i.test(f)).slice(0, 20);
    const corpus = [
        scan.libraryName,
        scan.readme.slice(0, 20000), // README 前 20k 字符足够覆盖特性描述
        depNames.join(' '),
        pathHints.join(' '),
    ].join('\n');
    for (const rule of CLASSIFY_RULES) {
        const strongHit = rule.strong.find((re) => re.test(corpus));
        if (strongHit) {
            const weakHit = rule.weak.find((re) => re.test(corpus));
            return {
                kind: rule.kind,
                reason: `强信号命中 ${strongHit.source.slice(0, 60)}${weakHit ? ` + 弱信号 ${weakHit.source.slice(0, 40)}` : ''}`,
                confidence: weakHit ? 95 : 85,
            };
        }
    }
    // 无强信号：看弱信号是否叠加（≥2 个不同弱信号才给中等置信度）
    for (const rule of CLASSIFY_RULES) {
        const weakHits = rule.weak.filter((re) => re.test(corpus));
        if (weakHits.length >= 2) {
            return {
                kind: rule.kind,
                reason: `弱信号叠加 ${weakHits.length} 个：${weakHits.map((r) => r.source.slice(0, 30)).join(' / ')}`,
                confidence: 55,
            };
        }
    }
    return { kind: 'unknown', reason: '未命中任何分类信号（需 LLM 或人工判定）', confidence: 0 };
}
/** 从原始扫描构建完整事实（纯函数）。 */
export function buildLibraryFacts(scan) {
    const cls = classifyKind(scan);
    const binaries = scan.binaryFiles.map((f) => ({ rel: f, kind: binaryKindOf(f) }));
    const binaryKinds = [...new Set(binaries.map((b) => b.kind))];
    const depNames = Object.keys(scan.ohPackage?.dependencies ?? {});
    // 构建目标：有 library 模块或纯库结构 → har；有 app/entry 模块 → hap
    const modules = scan.buildProfile?.modules ?? [];
    const hasAppModule = modules.some((m) => /^(entry|app|phone|default)$/i.test(m));
    const buildTarget = hasAppModule ? 'hap' : (modules.length > 0 ? 'har' : 'unknown');
    // demo 判定：存在 entry/src/main/ets 下的页面，或 README 提到 demo
    const etsPages = scan.files.filter((f) => /\.ets$/.test(f));
    const hasDemo = etsPages.some((f) => /\/(ets|pages)\//.test(f)) || /demo/i.test(scan.readme.slice(0, 5000));
    const entryFile = etsPages.find((f) => /Index\.ets$/.test(f))
        ?? etsPages.find((f) => /pages\/.*\.ets$/.test(f))
        ?? (scan.files.find((f) => /Index\.d\.ts$/.test(f)) ?? '');
    const needsLlm = [];
    if (cls.kind === 'unknown')
        needsLlm.push('库类别未识别（L0 无强信号，需 LLM 读 README 判定）');
    if (buildTarget === 'unknown')
        needsLlm.push('构建目标不确定（build-profile.json5 缺失或无 modules）');
    if (binaryKinds.some((k) => k.startsWith('so:'))) {
        needsLlm.push(`含二进制依赖 ${binaryKinds.filter((k) => k.startsWith('so:')).join(',')}（需决策：预编译产物 or 按 ABI 现编）`);
    }
    if (cls.confidence < 60 && cls.kind !== 'unknown')
        needsLlm.push(`类别置信度偏低（${cls.confidence}），需 LLM 复核`);
    const intel = extractReadmeIntel(scan.readme);
    // README 提到外部服务/硬件 → 必须 LLM 或人工确认（环境准备要外部依赖）
    if (intel.some((i) => i.kind === 'prerequisite' && /(服务|server|数据库|账号|token)/i.test(i.text))) {
        needsLlm.push('README 声明外部前置条件（服务/账号），环境准备需额外依赖');
    }
    return {
        kind: cls.kind, kindReason: cls.reason, confidence: cls.confidence,
        buildTarget,
        hasSubmodules: scan.gitmodules.trim().length > 0,
        hasBinary: binaries.length > 0,
        binaryKinds,
        hasDemo, entryFile,
        readmeChars: scan.readme.length,
        facts: {
            ohpmDeps: depNames,
            moduleNames: modules,
            apiLevel: scan.buildProfile?.apiLevel ?? '',
            fileCount: scan.files.length,
            hasHvigorw: scan.files.includes('hvigorw') || scan.files.includes('hvigorw.js'),
            hasEtsPages: etsPages.length,
        },
        resourceCandidates: scanResourceCandidates(scan),
        readmeIntel: intel,
        needsLlm,
    };
}
/** 是否有对应 preset（L1 能否直接命中）。presets 目录由 resourcekit/preset 注册表提供。 */
export function presetKindFor(kind) {
    return kind === 'unknown' ? null : kind;
}
