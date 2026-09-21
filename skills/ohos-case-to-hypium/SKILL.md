---
name: ohos-case-to-hypium
description: 把鸿蒙三方库的**手工测试用例**变成**可运行的 Hypium（xdevice + Python）自动化脚本**：按 HypiumProjectTemplate 的「单工程 + 库命名空间」落地 testcases/库名/库名_用例号.py 与配对 json，步骤映射为 hypium 原语（无法映射即失败，绝不降级成注释行），判据落到 aw/ 里的断言函数（绝不静默通过），并在真机上 dry-run 出报告。适用于「用例转脚本」「写自动化用例」「补 Hypium 框架」「跑一条自动化用例」等诉求，也用于审查已有脚本是否达标。不适用于编写手工用例本身（那是 ohos-library-testcase-pipeline）。
license: Apache-2.0
metadata:
  author: summer-hub
  version: "1.0.0"
  category: harmonyos-automation
  language: Python / ArkTS
  requires: HypiumProjectTemplate 工程骨架 + Python(hypium/xdevice) + hdc/真机；与 AutoTestAgent 平台 script_gen 阶段绑定
---

# 手工用例 → Hypium 自动化脚本

把「人写的用例」变成「机器能跑、跑完能判、判错能定位」的脚本。

## 什么时候用 / 不用

| 用 | 不用 |
|---|---|
| 把平台里/文档里的手工用例转成 Hypium 脚本 | 编写或完善**手工用例**本身（→ `ohos-library-testcase-pipeline`） |
| 现有 demo 能触发，但脚本缺失/跑不通要补齐 | 只要构建或安装 demo（→ `deveco-cli`） |
| 审查已有自动化脚本（断言为空、调不存在的 API、句式不可执行） | 纯接口层单测（→ `ohos-unit-test-generator`） |

## 三条不可违反的纪律

1. **无法映射的步骤 = 失败**，不产出注释行。注释行会让脚本"看起来正常"地跑完并通过 ——
   那是脚本级的假通过。改不成契约句式就如实报错，让人改用例。
2. **断言为空就不许落盘**。每个脚本至少一条可机器校验的断言（判据 → `aw/` 断言函数）。
   把"跑完了"当作"测过了"是本流水线最严重的错误。
3. **不臆造控件与 API**。控件文本逐字来自真机 dump（`devecocli ui layout`）或工程源码；
   只调用**核实存在**的 hypium API（`scripts/check_hypium_case.py` 会做白名单校验）。

## 工程布局（单工程 + 库命名空间）

所有库共用**一个** Hypium 工程（`HypiumProjectTemplate` 即骨架）：

```
<工程根>/                        # 例：workspace/hypium/
├── main.py                      # 骨架：从 argv 取模块名 → run -l <module>
├── run.bat / run.sh             # 骨架：本地一键跑
├── config/user_config.xml       # 骨架：设备 sn（执行前刷新，别提交）
├── aw/                          # 骨架：**共享能力**（只补缺，生成器不覆盖）
│   ├── Utils.py                 #   模板自带工具
│   └── autotest_oracle.py       #   判据断言模块（7 类 assert_*）
├── resource/
│   ├── baseline/<case>.zip|png  # 基线：框架 zip 与判据 png 同目录
│   └── images/                  # 素材
├── testcases/
│   └── <lib>/                   # 每库一个目录（命名空间）
│       ├── <lib>_<caseNo>.py    # 生成物：用例脚本
│       └── <lib>_<caseNo>.json  # 生成物：xdevice 驱动配置（成对，缺一不可）
└── reports/ tmp_hypium/         # 运行产物（不进版本库）
```

**为什么不是"每库一个工程"**：库一多，骨架就复制 N 份，改一个交互 bug 要去改 N 处；
`aw/` 里的共享能力会漂移成 N 个版本，"同一个平台生成的脚本行为不一致"。单工程多库的代价是
需要命名空间纪律（下面三条），收益是**只有一处需要维护**。

三条解耦纪律：

1. **跨库复用只能走 `aw/`**，禁止用例之间互相 import（否则删 A 库会连累 B 库）；
2. **脚本里不许出现设备 sn / 绝对路径 / 库路径**（设备在 `config/user_config.xml`，素材用 `resource/` 相对路径）；
3. **一条用例一个模块**；同一用例内部的重复执行（`for i in range(N)`）允许，那是稳定性/压力语义，
   不是"多条用例打包"（打包会让失败粒度丢失，也与平台的 caseNo↔module 绑定模型冲突）。

文件归属与幂等边界见 `references/project-layout.md`。

## 流水线（A0–A8）

```
A0 输入预检 → A1 可自动化性判定 → A2 步骤映射 → A3 判据映射 → A4 成对落地
                                                              ↓
                       A8 汇总报告 ← A7 绑定回写 ← A6 真机 dry-run ← A5 静态自检
```

### A0 · 输入与预检（只读）

| 项 | 怎么确认 |
|---|---|
| 手工用例 | 平台 DB / md / xlsx；至少要有 用例编号、步骤、预期（判据更佳） |
| 工程根 | 有 `main.py` + `testcases/`；没有就先按模板初始化骨架（`ensureHypiumProject` 等价物） |
| 库的 bundle / mainAbility | 平台库记录，或 `AppScope/app.json5` / `module.json5`；**启动应用要用显式 ability** |
| 设备 | `devecocli device list`；无设备 → 见文末降级 |
| **设备已解锁** | 屏幕锁定时 `aa start` 直接失败：`10106102 The device screen is locked during the application launch, unlock screen failed`。**开发模式下不会自动解锁，必须人先解锁**。检测：`hdc shell power-shell wakeup` 后 dump 一次，看到锁屏键盘就是没解锁 |
| Python 环境 | **必须用装了 hypium 的解释器**（`python -c "import hypium"` 成功那个；本机常在 3.10）。另需 `xdevice`（`python -c "from xdevice.__main__ import main_process"`） |

### A1 · 可自动化性判定（先判能不能自动，再动手写）

逐条判定，并写明依据：

| 判定 | 条件 | 处置 |
|---|---|---|
| **auto** | 界面可触发 + 有可机器校验判据 + 不依赖外部系统 | 进 A2 |
| **human** | 需要外接数据库/第二台设备/真实网络；需要人观察（动画流畅度、音画同步）；耗时数十分钟以上 | 进人工接管清单，写清"需要人做什么"，**不写脚本** |
| **blocked** | 判据缺失或不可核对 | 先回手工用例补判据（不补就不写脚本，否则必然假通过） |
| **needs-demo** | 界面没有入口/参数注入点 | 先走 demo 改造（`ohos-library-testcase-pipeline` 的 S5），改完再回来 |

### A2 · 步骤 → hypium 原语映射

契约句式与映射表见 `references/step-mapping.md`。要点：

- 只认契约句式（打开应用 / 点击「X」/ 输入「X」到「Y」/ 等待 N 秒 / 上滑 / 下滑 / 返回 / 验证「X」）；
- **无法映射 → 抛错并回报步骤序号与原文**，不写注释行；
- 控件文本要**逐字**一致（`BY.text` 是精确匹配）；单字符控件只能全等匹配，别做子串匹配；
- 启动应用用 `start_app(package_name=..., page_name=...)`；杀掉用 `stop_app`；
- 需要"滚动到某控件"时优先用 `driver.swipe(UiParam.UP, ...)` 或 `scroll`，并**在真机上确认能滚到**
  （页面没有滚动容器时，新增入口可能根本够不到 —— 实测踩过）。

### A3 · 判据 → 断言映射

7 类判据与 `aw/autotest_oracle.py` 的对应关系见 `references/oracle-mapping.md`。硬要求：

- 每条判据都要落到一条断言调用；**判据为空 → 拒绝生成**；
- 断言失败要抛框架认的异常（`devicetest.core.exception.TestAssertionError`）；
- **首跑不许静默通过**：截图对比首次运行会存基线并判失败，等人工确认基线后重跑才算通过。

### A4 · 成对落地

- 写入 `testcases/<lib>/<lib>_<caseNo>.py` **和** `<lib>_<caseNo>.json`；
- 命名四方一致：**文件名 = Python 类名 = `-l` 模块名 = 报告里的模块名**；
- 幂等：内容没变就不重写（避免无意义的 hash 变化把绑定判成 stale）。

### A5 · 静态自检（不通过不落盘）

```bash
python scripts/check_hypium_case.py <工程根>/testcases/<lib>/<lib>_<caseNo>.py
python scripts/check_hypium_case.py <工程根>/testcases/<lib>        # 目录模式：检查成对与一致性
```

检查项：语法可编译、类名=模块名、至少一条断言、无注释行冒充步骤、driver API 白名单、
`aw/` 导入路径、`.py`/`.json` 成对且 `driver.py_file` 指向正确。
**它说通过不代表用例写得好，但它报的问题必须逐条修掉。**

### A6 · 真机 dry-run 闭环

```bash
# 用装了 hypium 的解释器；模块名 = 文件名去扩展名
<python> main.py <lib>_<caseNo>
# 结果：reports/latest/result/<module>.xml
```

- 通过/失败都要留证据：报告 xml、截图、hilog 片段；
- 失败**必须归因**到三类之一（见 `references/failure-triage.md`）：
  **用例描述错 / demo 没入口 / 库真有问题**。不许写"环境问题"了事；
- 「脚本通过但断言一条都没被校验」= **假通过**，判失败；
- 首次跑截图判据会失败（存基线），这是设计而非故障 —— 要让基线被人确认过。

### A7 · 绑定回写

- 记录 `用例号 ↔ 模块名 ↔ 脚本 hash`；
- 用例升版 → 脚本标 **stale**（提示"可能过期"）；人工改过脚本 → 标 **manual** 且**不自动覆盖**；
- 脚本文件缺失 → **broken**（不是"通过"）。

### A8 · 汇总

产出：脚本清单（模块名/用例号/判据条数）、dry-run 结果、人工接管清单、失败归因清单。
**没做到的（未验证、无设备、需要人做）必须显式写出来。**

## 与 AutoTestAgent 平台的衔接

| 平台能力 | 对应到本技能 |
|---|---|
| `script_gen` 阶段（任务「用例转自动化脚本」） | 本技能即该阶段的绑定技能；轨迹里会打印生效绑定 |
| `case_script_bindings` | A7 的绑定状态（fresh/stale/manual/broken） |
| oracle 门禁 / 质量页 | A3 的判据映射；断言覆盖率与假通过统计 |
| 人工队列 | A1 判出的 human 项 |
| 执行计划 | 按模块逐个跑 `main.py <module>`，解析 `reports/latest/result/<module>.xml` |

## 降级路径（如实写，不要装作做到了）

| 情况 | 怎么办 |
|---|---|
| 无真机 | 脚本照生成 + A5 静态自检；**A6 标"未验证"**，并说明需要设备才能确认 |
| 没有装了 hypium 的解释器 | 不要硬跑：说明需要 `pip install hypium` 或用哪个解释器，先做 A5 |
| demo 没有入口 | 回 `ohos-library-testcase-pipeline` 的 S5 改造；**不要用坐标硬点不存在的东西** |
| 判据不可核对（"功能正常"） | 拒绝生成，让人补判据（这是从源头堵假通过） |

## 参考文件

- `references/project-layout.md` — 单工程多库布局、文件归属与幂等边界、旧布局迁移、多库并发注意事项
- `references/step-mapping.md` — 契约句式 → hypium 调用映射表 + 无法映射的处置
- `references/oracle-mapping.md` — 7 类判据 → `aw/` 断言函数 + 反假通过规则
- `references/naming-binding.md` — 命名四方一致、绑定状态、报告解析与结果判定
- `references/failure-triage.md` — 失败归因三分法与人工接管模板
- `scripts/check_hypium_case.py` — 脚本/目录静态自检（纯标准库，可离线跑）
