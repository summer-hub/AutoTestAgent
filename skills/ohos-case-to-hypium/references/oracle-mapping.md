# 判据（oracle）→ 断言映射

判据来自手工用例里的「判据」列（见 `ohos-library-testcase-pipeline` 的 `oracle-rules.md`）。
每一条都必须落到脚本里的一次断言调用；**落不下去就拒绝生成脚本**。

## 映射表

| 判据类型 | 字段 | 生成调用（`aw/autotest_oracle.py`） | 说明 |
|---|---|---|---|
| `control_text` | `{control, expect: appear\|disappear}` | `assert_control_text(driver, "控件文本", expect="appear")` | 界面出现/消失指定控件文本 |
| `text_value` | `{control, op: contains\|equals\|matches, value}` | `assert_text_value(driver, "控件", "contains", "值")` | 控件文本等于/包含/正则；**值必须是界面上真会出现的文本或错误码** |
| `state_flag` | `{control, state}` | `assert_state_flag(driver, "控件", expected=True)` | 勾选/开关状态 |
| `hilog_keyword` | `{keyword}` | `assert_hilog_keyword(driver, "关键字")` | 日志出现关键字（含错误码） |
| `no_crash` | `{}` | `assert_no_crash(driver, package_name="<bundle>")` | 执行期间无 E 级日志、应用仍在前台 |
| `screenshot_diff` | `{threshold}` | `assert_screenshot_diff(driver, threshold=0.05, name="<module>")` | 与基线比像素差异 |
| `script_assert` | `{expr}` | 直接写该表达式（**非恒真**） | 脚本内断言；`assert true` 或裸 `true`/`1` 一律拒绝 |

## 断言模块的硬约定（`aw/autotest_oracle.py`）

- 所有断言**失败即抛** `devicetest.core.exception.TestAssertionError`（框架会判用例失败）；
- **找不到控件 = 判据无法成立 → 抛错**，不是"跳过"：
  拿不到证据就判失败，比"没看到就当通过"诚实；
- 只用**已核实存在**的 hypium API：
  `wait_for_component` / `wait_for_component_disappear` / `get_component_property` /
  `current_app` / `shell` / `capture_screen` / `BY.text`。
  **`driver.assert_*` 系列在 hypium 里不存在**（曾因此产出过必然 AttributeError 的脚本）；
- 该模块放在 **共享 `aw/` 包**里（`from aw.autotest_oracle import ...`），不是每个库一份 ——
  一个库里修好的断言行为，所有库立刻受益。

## 截图基线（两套基线，别混）

| 谁产的 | 位置 | 用途 |
|---|---|---|
| xdevice 框架（`-ta screenshot:true`） | `resource/baseline/<case>.zip`（内含 case/md5/deviceModel/adaptive 等元信息） | 框架自己的截图对比 |
| `assert_screenshot_diff` | `resource/baseline/<module>.png`（首跑自动落盘） | 判据用的像素比对 |

两者**同一个目录、不同扩展名**，刻意如此：避免"工程里有两套基线目录、各说各话"。

**首跑规则**：没有基线时保存当前截图并**判失败**，提示人工确认基线后重跑。
绝不静默通过 —— 静默通过等于把"没测"报成"测过了"。
可用环境变量 `AUTOTEST_BASELINE_DIR` 覆盖基线目录（CI/多机场景）。

## 反假通过清单（生成前自查）

| 形态 | 判定 |
|---|---|
| 脚本里没有任何断言 | 拒绝落盘（并报"用例缺判据，回去补"） |
| 判据为空数组 | 拒绝落盘 |
| 判据是"正常/成功/符合预期"这类不可核对值 | 拒绝落盘（让人改用例） |
| 断言恒真（`assert true`、裸 `true`/`1`） | 拒绝落盘 |
| **跑完：通过，但 `oraclesChecked == 0`** | **判失败**，并回报"没有任何判据被校验" |
| 跑完：通过，有断言，但步骤里没有任何验证动作 | 判**弱通过**，提示补验证步骤 |
