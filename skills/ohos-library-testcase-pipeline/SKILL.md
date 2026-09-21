---
name: ohos-library-testcase-pipeline
description: 面向鸿蒙（HarmonyOS/OpenHarmony）三方库工程的测试用例编写流水线：输入库工程代码、需求文档与现有 demo，输出覆盖「正向 / 空值 / 边界异常 / 大数据」四类场景、且每条都带可机器校验判据的测试用例；接口覆盖率以「对外导出接口」为分母逐条核对，现有 demo 覆盖不到的场景产出最小代码改造并真机验证。串联 deveco-cli（构建/真机/日志/文档）与 ohos-library-spec-analyzer、ohos-demo-scenario-generator、ohos-arkts-demo-doc-generator、ohos-demo-code-generator、ohos-library-test-generator、ohos-unit-test-generator 等技能。当用户要求为鸿蒙三方库写测试用例、补测试场景、评估接口覆盖、为了测试而改造 demo，或提到「空值/边界/异常/大数据场景现有 demo 测不了、需要改代码」时使用。
license: Apache-2.0
metadata:
  author: summer-hub
  version: "1.0.0"
  category: harmonyos-testing
  language: ArkTS/ETS
  requires: deveco-cli（构建/真机/日志）; 可选 hdc、DevEco Studio、真机或模拟器
---

# 鸿蒙三方库测试用例流水线

把「库工程代码 + 需求 + 现有 demo」变成「**可执行、可核对、覆盖率可证伪**的测试用例」，并且
**在现有 demo 测不到的场景上，产出最小代码改造**。

## 什么时候用 / 不用

| 用 | 不用 |
|---|---|
| 给一个鸿蒙三方库（HAR/HSP 或含 `library` 模块的工程）系统性地写测试用例 | 只问某个 API 怎么用（→ 直接查文档） |
| 想知道"这个库对外接口测到什么程度了、缺哪些" | 只要求生成一份接口规格说明（→ `ohos-library-spec-analyzer`） |
| 现有 demo 点不到的地方要补测试入口/参数注入点 | 只要跑一次构建或装个包（→ `deveco-cli`） |
| 要"正向/空值/边界异常/大数据"四类场景全覆盖 | 纯 C/C++ 库的主机侧编译验证（→ `openharmony-cpp-adaptation`） |

## 三条不可违反的纪律

这三条是本流水线存在的理由，任何阶段都不得为了让报告好看而放松：

1. **假通过 0**：每条用例必须有**可机器校验的判据**（界面上真正会出现的文本、勾选状态、hilog
   关键字、截图差异之一）。禁止"正常/成功/功能正常/符合预期/可用"这类无法核对的期望值；
   禁止恒真断言（`assert true`，或光秃秃一个 `true`/`1`）。
2. **不虚报覆盖**：判定"已覆盖"必须同时满足「demo 里真实调用过」**且**「至少一条负向用例」。
   只有正向、只有单元测试调用、只有类型声明，都**不算**已覆盖（分别判 partial / partial / 不可测）。
3. **不臆造控件与结论**：用例步骤里引用的控件文本必须逐字来自**真机 dump**（`devecocli ui layout`）；
   拿不到的证据就写"未获取"，绝不编造文件行号、控件名、覆盖率。

## 输入与预检（S0）

先只读地建立事实基线，**此时一行代码都不要改**：

| 项 | 怎么确认 | 缺失时 |
|---|---|---|
| 库工程路径与库模块 | 找 `build-profile.json5` / `oh-package.json5`；库模块通常在 `library/`，入口 `library/Index.ets` 或清单里的 `main`/`types` | 让用户指明，不要猜 |
| 工程能否构建 | `devecocli build --modules <library>`（**build 用 `--modules`，run 用 `--module`，单复数不一致**；先跑一次全量，后续才有增量） | 构建不通就先修环境，别急着写用例 |
| 设备 | `devecocli device list`；或在线的 `hdc list targets` | 无设备 → 走"无设备降级"（见文末），并把真机相关结论标为待验证 |
| demo 是否**已安装** | `hdc shell bm dump -a \| grep <bundle>`；没装就 `devecocli run --module <demo模块> --device <serial>` | 未安装 → 先装（否则拿不到真机控件，S7 全部只能标"未验证"） |
| 现有 demo | demo 模块（`entry/`）的页面清单、导航入口 | 无 demo → 需要先造 demo（`ohos-demo-code-generator`） |
| 需求文档 | 用户提供或有 SRS | 没有就用"库全量接口"为准，并在报告里写明"本次无需求轴" |

> ⚠️ **构建/运行会改写用户仓库（工具链行为，实测）**：`devecocli build` / `run` 会就地"升级"工程 ——
> 实测把 `build-profile.json5` 的 `compileSdkVersion/compatibleSdkVersion` 与 `runtimeOS`
> 从 `OpenHarmony`(API 10) 改成 `HarmonyOS`(26.0.0)、自动补 `signingConfigs`、改
> `oh-package.json5` 的 `modelVersion`、**删除旧 `hvigorw`/`hvigorw.bat`/`hvigor-wrapper.js`**，
> 并生成 `library/BuildProfile.ets`。
> 所以动手前**先记录 git 基线**（`git status --porcelain`），完事把工具链改动**明确写进报告**，
> 并按用户意愿还原（`git checkout -- <files>` + 删除生成的未跟踪文件）。这不是"补丁污染"，
> 但同样是"用户仓库被改了而没人说" —— 一样要报。

## 流水线（S1–S8）

```
S1 接口面分母 → S2 需求轴（可选）→ S3 覆盖矩阵 → S4 场景设计
                                                   ↓
                        S8 汇总报告 ← S7 真机验证闭环 ← S6 用例成文 ← S5 需要就改代码
```

### S1 · 接口面分母：先把"要测什么"变成可核对的清单

调用 `ohos-library-spec-analyzer`（鸿蒙库，读 `library/Index.ets` 导入链）或
`library-interface-analyzer`（更通用的多语言版）。产出接口清单，每条至少记录：

```
接口名 | 类型(function/class/interface/type/enum) | 签名 | 参数(含可选/默认值) | 返回 |
声明异常 | 源码位置(file:line) | 类的话列出方法
```

原则：

- **入口必须读工程清单**（`oh-package.json5` 的 `types` → `main` → 约定文件名），不要凭文件名猜；
- 编译产物（`build/`、`.d.ets`）常被 gitignore，**源码 export 链才是主力**；
- 打包产物形态要认（`var X = (exports.X = function X(){})`、`X.prototype.m = function(){}`、
  多行 `export {a as B} from './x'`）；
- 类型只存在于 JSDoc 时，`@param/@returns/@throws/[可选]` 必须合并进参数，否则参数是光秃秃的名字；
- **分母要分清**：`type`/`interface` 声明没有运行时行为，真机上既触发不了也断言不了 → 单独标记，
  不进"可测分母"（否则类型多的库覆盖率天然难看，指标失去意义）。

### S2 · 需求轴（可选，但有需求就必须做）

把需求文档拆成**需求点**，逐条映射到 S1 的接口：`需求点 → 覆盖它的接口 → 已有哪些 demo 入口`。
映射结果要能回答两件事：**哪条需求没有任何接口承接**（需求缺口）、**哪个接口不服务任何需求**
（多余能力，可选测）。没有需求文档就跳过，并显式写明"本次按库全量接口为轴"。

### S3 · 覆盖矩阵：让"覆盖够不够"变成可逐行核对的事实

对每个接口建立一行，列 = `接口 × demo 调用点 × 真机可达控件 × 已有用例 × 状态 × 风险`。
判定规则与风险标记的完整口径见 `references/coverage-matrix.md`。要点：

- **demo 调用点**来自源码扫描（`src/main`），**区分**单元测试调用（`src/ohosTest`）——单测跑通 ≠ 真机覆盖；
- **真机控件**来自 `devecocli ui layout --device <serial> --format json` 的 dump：把"接口的 demo 调用页"
  与"真机上真实出现过的页面"对上，取该页控件清单；
- **三种假覆盖必须分开**：① 页面上展示用的**样例代码字符串**不是调用；② `x.validate()` 这种成员调用
  不等于导出了 `validate`；③ 单元测试调用不算真机覆盖。

### S4 · 场景设计：四类场景逐接口展开

对每个**可测**接口按四类场景展开（规则表见 `references/scenario-rules.md`）：

| 场景 | 该怎么造 | 是否算负向 |
|---|---|---|
| 正向 happy | 常规合法输入，走通主路径 | 否 |
| 空值 empty | 空串/空数组/null/undefined/未设置/空文件/空数据源 | **是** |
| 边界异常 boundary | 极值、临界值、非法类型、越界索引、重复调用、状态机乱序（未 start 就 stop） | **是** |
| 大数据 bigdata | 超大集合、超长文本、大文件、高频刷新 | 否（压力而非负向） |

同时给出**适用性**：不适用就写明理由，**不硬造**（例：没有可选参数、没有容器参数、没有尺寸类参数时，
空值/大数据场景不适用）。用例条数要能解释：`适用维度数 + 额外负向条数`。

每条用例判定**可测性**（决定要不要走 S5）：

| 类 | 含义 | 处置 |
|---|---|---|
| **A 开箱可测** | 现有 demo 的页面/控件就能触发并观察到结果 | 直接写用例 |
| **B 改参数可测** | 需要把测试输入改成空值/极值，但 demo 的输入数据点在源码里是常量/`@State` | 在工程副本上改**测试数据**，不改库代码 |
| **C 需改 demo 代码** | 现有 demo 没有入口或没有参数注入点（如大数据场景要生成大集合、异常场景要跳过前置校验） | 走 S5：产出最小改造 + 构建 + 真机验证 |
| **D 无法测** | 需要外接数据库/第二台设备/真实网络、依赖人工观察（动画是否流畅）、需要极长耗时 | 进**人工接管清单**，写明"需要人做什么"，不假装测过 |

### S5 · 需要改代码的场景：最小改造，且必须验证

只对 C 类做，规范见 `references/demo-patch-rules.md`。硬性要求：

1. **只在工程副本上改**（如 `workspace/demo-patches/<库>/<用例号>/`），绝不直接改用户仓库；
   注意**构建也属于"会改仓库"的动作**（见 S0 的警告），所以构建优先在副本里做；
2. **最小侵入**：优先"新增"而不"修改"（加一个入口按钮/加一个参数注入点），不改既有逻辑；
3. **可回退**：补丁带 `before`/`after` 与文件位置，且能一键还原；改完不能还原就别做；
4. **改完必须验证**：`devecocli build` 构建通过 → `devecocli run` 装到真机 → 该场景真的能触发
   （有截图/日志为证）。**改完不验证 = 没做**；
5. 如果改造会改变库的行为或污染用户工程 → 停下来要人确认。

改造方式（从最轻到最重）：① 改 demo 里的测试数据常量 → ② 新增一个注入不同数据的按钮/开关 →
③ 新增一个测试页面并在主页加入口 → ④ 真的需要改库代码（此时要人确认，并说明这是被测对象变更）。

### S6 · 用例成文：模板 + 机器自检

用 `references/output-templates.md` 的用例表模板产出，每条必须有：
`编号 | 接口 | 场景 | 优先级 | 前置 | 步骤 | 预期 | 判据(oracle) | 可测性 | 证据/关联`

判据取值域与禁止写法见 `references/oracle-rules.md`（控件文本出现/消失、控件文本等于/包含/正则、
勾选状态、hilog 关键字、无崩溃、截图差异、非恒真脚本断言）。

**成文后必须跑机械自检**：

```bash
python scripts/check_cases.py <用例文件.md>
```

它只做确定性检查（判据缺失/含糊、步骤句式越界、编号重复、接口未登记），输出问题清单；
**它说通过不代表用例写得好**，但**它报的问题必须逐条修掉**。

**交付/入库时导出 xlsx**（md 是工作格式，xlsx 是交付格式）：

```bash
python scripts/export_cases_xlsx.py <用例文件.md> --profile generic              # 给人评审（含判据列）
python scripts/export_cases_xlsx.py <用例文件.md> --profile autotest-platform    # 给平台「用例页 → 导入 Excel」
```

- 两种列结构的差别见 `references/output-templates.md`；
- 有 `openpyxl` 就用它（统一 Arial、表头样式、列宽、冻结首行），没有就**自动降级为纯标准库写入**，
  内容完全一致 —— 技能不假设任何第三方包，任何机器都能出 xlsx；
- 导出前先过 `check_cases.py`：带着机械性问题的用例不该被做成交付件。

> ⚠️ **平台导入会丢掉「判据」列**：AutoTestAgent 的导入器只认它那 10 列（`normalizeCaseRow` 的别名表里
> 没有"判据"，INSERT 也不写 `oracle_json`）。导入后这些用例在平台里仍是"没有可机器校验判据"的状态，
> 平台自己的质量门禁会据此判为草案。要"导入即合规"，得先给平台导入器加判据列映射 ——
> 这是平台侧的小改动，导出脚本会在 stdout 把这条提醒打出来，别让它变成"没人知道的事"。

### S7 · 真机验证闭环

```bash
devecocli build --modules entry                       # 只构建（build 用复数 --modules）
devecocli run --module entry --device <serial>        # 装到真机并启动（run 用单数 --module）
devecocli ui layout --device <serial> --format json   # 取真实控件清单，核对用例步骤里的控件是否存在
devecocli log --level E                               # 跑完看有没有崩溃/错误级日志
```

四个真机上一定会遇到的坑（都实测过）：

1. **`ui layout --format json` 的 stdout 末尾会被追加升级提示**（`New version 1.3.3 available…`），
   直接 `JSON.parse` 会炸 → 取**首个 `[` 到末个 `]`** 之间的内容再解析。
2. **控件常常没有 `id`** → `ui click --id` 用不了，只能按 `bounds` 算中心点用坐标点击
   （`ui click <x> <y>`）。坐标点击本身就脆弱，这也是要把控件清单 dump 下来的原因之一。
3. **前台应用会被别人抢走**（真机是人在用的手机）→ dump 之前先确认前台是被测应用，
   dump 之后**用预期文本核对**（例如首页应出现 demo 自己的入口文案），否则你拿到的是别的 App 的控件。
4. **点击可能被启动动画吃掉** → 首次点击后要 dump 确认页面真的变了，没变就重试一次，
   不要据此判定"用例失败"。

- 通过/失败都要留证据：截图、hilog 片段、dump 片段；
- 失败要归因到**用例错 / demo 没入口 / 库真有问题**三类之一，不要笼统写"环境问题"；
- "脚本通过但没有任何判据被校验" = **假通过**，必须判失败。

### S8 · 汇总报告

产出四件东西（模板见 `references/output-templates.md`）：

1. **接口覆盖矩阵**（分母/已覆盖/部分/未覆盖/不可测，逐接口带证据）；
2. **未覆盖清单**（每条写明"缺什么、为什么没覆盖、补它需要什么"）；
3. **人工接管清单**（D 类，每条写明"需要人做什么、做完怎么回流"）；
4. **改造清单**（C 类补的是什么、在哪、验证结果、怎么回退）。

报告里**所有数字都要能从矩阵逐行核对**，不许出现"覆盖率约 80%"这种无法举证的说法。

## 子技能调用表

| 阶段 | 调用 | 输入 | 拿到什么 |
|---|---|---|---|
| S0/S5/S7 | `deveco-cli` | 工程路径、设备 | 构建/运行/真机 dump/日志/官方文档检索 |
| S1 | `ohos-library-spec-analyzer` 或 `library-interface-analyzer` | 库工程 | 接口规格说明文档（分母） |
| S2/S4 | `ohos-demo-scenario-generator` | 接口规格文档 | 正向+反向场景列表（含体验指标/用户期望） |
| S4/S6 | `ohos-arkts-demo-doc-generator` | 接口规格文档 | 以函数为单位的 demo 描述（名称/步骤/预期） |
| S3/S4（覆盖度量化） | `ohos-demo-coverage-analyzer` | Demo 场景文档 + `entry/` 现有代码 | **场景/代码维度的覆盖率**：已覆盖 / 部分覆盖 / 未覆盖 + 差距证据 + 补充优先级。与接口维度矩阵互补 —— 一个看"接口测没测"，一个看"规划的场景有多少真的落到 demo 代码里" |
| S5 | `ohos-demo-code-generator` | demo 描述文档 | 可编译运行的 ArkTS demo 页面 |
| S6 | `ohos-library-test-generator` | API 结构 | 功能/边界/异常/性能/集成用例表格 |
| S6（可选） | `ohos-unit-test-generator` | 接口规格 | Hypium 单测 + 执行脚本 + 覆盖率（**单测 ≠ 真机覆盖**） |

这些技能产出的文档是**素材**，不是最终答案：必须再按上面的三条纪律与矩阵口径核对一遍。

## 无设备 / 环境不全时怎么办（降级，但要说清楚）

| 情况 | 怎么办 |
|---|---|
| 无真机/模拟器 | A/B 类用例照写；**所有需要真机确认的结论标"未验证"**；D 类如实进人工清单 |
| 工程构建不起来 | 先修构建（缺 SDK/依赖/签名），**不要在构建不通的情况下声称用例可执行** |
| `ui layout` 拿不到控件 | 用例步骤标"控件待真机核对"；未核对的控件引用不得进入最终用例 |
| 依赖的外部 MCP/知识库不可用 | 用本地源码与文档替代，并在报告里写明降级了哪一步 |
| 库是纯 C/C++ | 真机 UI 路线不适用，转设备侧验证（`openharmony-cpp-device-verify`） |

## 产出物命名建议

```
<库名>-接口清单.md            S1
<库名>-覆盖矩阵.md / .csv      S3
<库名>-测试用例.md            S6（工作格式，含判据列；机械自检的对象）
<库名>-测试用例.xlsx          S6（交付/入库格式，由 export_cases_xlsx.py 导出）
<库名>-人工接管清单.md         S8
<库名>-demo改造/<用例号>/      S5（补丁 + 副本 + 验证证据）
```

## 参考文件

- `references/coverage-matrix.md` — 矩阵列定义、状态判定规则表、风险标记
- `references/scenario-rules.md` — 四类场景适用性与展开规则、可测性 A/B/C/D 判定
- `references/oracle-rules.md` — 可机器校验判据的取值域、禁止写法、假通过判定
- `references/demo-patch-rules.md` — demo 最小改造规范、工具链改写工程的实测记录、ArkTS 拦人的写法
- `references/output-templates.md` — 各产出物的表格模板与 xlsx 列结构
- `scripts/check_cases.py` — 用例文件机械自检（确定性检查，纯标准库，可离线跑）
- `scripts/export_cases_xlsx.py` — 导出 xlsx（有 openpyxl 用 openpyxl，没有则纯标准库降级）
- `scripts/fixtures/` — 自检脚本的正/反样例（`cases_good.md` / `cases_bad.md`），改规则后拿它们回归
