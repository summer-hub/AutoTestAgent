# AutoTest Web 端 & 桌面端 — 浏览器全量测试报告

- 测试时间：2026-10-12
- 测试方式：真实浏览器驱动（零依赖 CDP 客户端，Node 24 原生 WebSocket）
  - Web 端：headless Chrome（隔离 profile，调试端口 9222）
  - 桌面端：**直连 Tauri 应用自己的 WebView2 窗口**（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`），不是另开浏览器
- 测试范围：全部 17 个 hash 路由页面 + 设置弹窗交互 + 桌面端进程/托盘/防孤儿行为
- 每页校验项：面包屑正确切换、渲染非空白（root HTML）、无 ErrorBoundary 回退、顶栏后端徽标含版本号（API 连通）、console.error / 未捕获异常 / 网络失败收集、整页截图

## 结果总览

| 项 | Web 端（独立服务器） | 桌面端（Tauri 窗口） |
|---|---|---|
| 页面遍历 | **17/17 通过** | **17/17 通过** |
| console.error | 0 | 0 |
| 未捕获异常 | 0 | 0 |
| 网络失败 | 1（契约内空态，见下） | 1（同上） |
| 设置弹窗交互 | ✅ | ✅ |
| 后端徽标 | `v1.0.0-rc.1 · sqlite` | `v1.0.0-rc.1 · sqlite` |

桌面端附加行为验证：

| 行为 | 结果 |
|---|---|
| 进程树（exe + node 子进程） | ✅ |
| 数据目录隔离（`%APPDATA%/com.autotest.platform`） | ✅ |
| 随机端口 + `AUTOTEST_LISTENING` 协议 | ✅ |
| 关闭按钮 → 隐藏到托盘（WM_CLOSE 后进程与服务均存活） | ✅ |
| 硬杀桌面进程 → Job Object 终结 node 子进程（无孤儿） | ✅ |

## 本轮发现并修复的缺陷

### P0 — gzip 分支 MIME 错误导致浏览器把首页当文件下载（`static.ts`）

- 现象：真实浏览器打开应用，主框架导航被 Chrome 判定为下载（`isDownload: true`），白屏。
- 根因：`serve()` 里 `extname('index.html.gz').replace(/\.gz$/,'')` 得到空串 → MIME 查不到 → 回落 `application/octet-stream`。
- 为何之前没暴露：curl 默认不发 `Accept-Encoding: gzip`，走非压缩分支（MIME 正确）；**只要客户端接受 gzip 就 100% 中招**。
- 修复：先剥 `.gz` 再取扩展名推导 MIME。已用 `curl --compressed` 复检（`text/html` / `text/javascript` + `Content-Encoding: gzip`）。

### P1 — `/libraries/sheet` 被 `/libraries/:id` 路由遮蔽（`api/http.ts`）

- 现象：库管理页请求 `GET /api/autotest/libraries/sheet` 返回 404「库不存在」。
- 根因：mini router 线性匹配，`/libraries/:id`（先注册）捕获单段静态路径（`Number('sheet')`=NaN）。代码里 `/cases/export` 有注释说明该坑但漏了此路由。
- 修复：路由匹配改为**静态段优先的两遍扫描**（不再依赖注册顺序），`verify:api` 回归通过，修复后接口返回正常 JSON。

### 测试器加固（非产品缺陷）

- `ui-walk.mjs` 首屏导航增加 `errorText` / `isDownload` 显式检查——P0 bug 最先就是被"17 页全空但零报错"的异常签名暴露的，静默失败必须大声失败。

## 契约内空态（非缺陷）

`GET /repos/:id/files?root=scripts` 在全新工作区返回 404（文案：「该库还没有 Python/Hypium 脚本，请先执行用例转自动化脚本」）——这是 API 对"未生成脚本"的既定契约，前端正常降级渲染，已在遍历器中白名单归类。

## 最终回归

两个产品修复后重跑全量门禁：`npm run verify:all` → **1104 PASS / 0 FAIL / 22 套自检**（含插件全量构建）。

## 归档

- 截图与机读报告：`autotest/.test-results/web/`（18 张）、`autotest/.test-results/desktop/`（18 张），各含 `report.json`
- 测试工具（可复用）：`autotest/scripts/browser-test/cdp.mjs`（CDP 客户端）、`ui-walk.mjs`（页面遍历器）、`probe.mjs`（诊断探针）
- 桌面端安装包已用修复后资源重建：`desktop/src-tauri/target/release/bundle/nsis/AutoTest_1.0.0-rc.1_x64-setup.exe`（32.92 MiB）

## 复跑方式

```bash
# Web 端
cd autotest/dsh-autotest && AUTOTEST_PORT=3500 AUTOTEST_HOST=127.0.0.1 node lib/standalone.js &
cd autotest && node scripts/browser-test/ui-walk.mjs --base http://127.0.0.1:3500 --out .test-results/web --launch 9222

# 桌面端（先启动应用并带 WebView2 调试端口）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" ./autotest-desktop.exe &
node scripts/browser-test/ui-walk.mjs --base http://127.0.0.1:<端口> --out .test-results/desktop --connect 9223
```

## 遗留事项

- 技能打包缺口仍在：独立版/桌面端未打包仓库根 `skills/`（AI 生成用例/脚本时 agent 需要读 SKILL.md），已与用户确认过，待决策后实施。
- 桌面端安装包未做代码签名（SmartScreen 拦截）与自动更新，文档已留占位。
