---
name: autotest-case-author
description: 为 AutoTest 平台（DeepSeek Harness 插件）基于已下载的鸿蒙三方库真实工程编写/更新测试用例：解析 bundleName、mainAbility 与 entry 页面，设计界面上真实可触发的步骤，并把预期结果落到具体动画、UI 表现与 hilog 日志。适用于编写/更新/审查该平台用例，不适用于与真实工程无关的通用用例生成。
---

# Autotest Case Author

## 目标

产出**基于真实工程代码**的鸿蒙 UI 测试用例：操作步骤必须能在真实界面上触发，预期结果必须具体可验证（动画名、UI 表现、hilog 日志），而不是泛泛的"功能正常"。

## 用例来源语义（写入用例时严格区分）

- `AI 生成`：由 AI（平台 write_cases 任务或本流程）产出
- `老库存量`：通过 Excel 导入
- `问题单跟踪`：关联 DTS 问题单（cases.dts_url 填可跳转链接）

## 工作流

1. **定位真实工程**：仓库位于 `app.workspace/repos/<库名>`。未克隆时先走平台任务「拉取仓库代码」，或 `git clone`。
2. **解析工程结构**：
   - `AppScope/app.json5` / `entry/src/main/module.json5` → `bundleName`、`mainAbility`
   - `entry/src/main/ets/pages/*.ets` → 真实页面列表与控件
   - 阅读入口页与主要页面代码、`resources/base/element/string.json` 等，列出真实按钮文本、输入框、开关、列表项、动画资源（Lottie json / 进度条 / 转场）与 `hilog` 打印语句
3. **设计用例**：覆盖正向/边界/异常；操作步骤用「打开应用 / 点击「xxx」/ 输入 xxx / 滑动 / 等待 N 秒 / 验证「xxx」」等真实动作；预期结果写明具体动画文件、UI 表现或应打印的日志（含 tag 与内容）。
4. **落库**：
   - 新增：`POST /api/autotest/cases`（libraryId / caseNo / name / source / precondition / steps[] / expected / dtsUrl），编号 `C-<库名前缀>-NNN`
   - 更新：`PUT /api/autotest/cases/:id`（版本自动递增，changeNote 写清更新点，authorType `human`/`ai`）
   - 删除：`DELETE /api/autotest/cases/:id`
5. **自检**：每个步骤必须能被 hdc 执行原语映射（点击/输入/滑动/等待/验证文本/打开应用）；验证类步骤对应的控件或文本应存在于页面代码中；不臆造不存在的控件或动画。

## 平台内置 AI 提示词

平台 `write_cases` 任务已内置上述要求（executor.ts 的用例生成 prompt，会注入仓库解析出的 bundleName/页面/入口代码）。本技能用于人工/代理执行同样的方法论，或审查平台 AI 产出是否达标。
