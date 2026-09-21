# 命名、绑定与结果判定

## 命名四方一致

一个模块名要同时出现在四个地方，任何一处不一致都会导致"脚本在但跑不了"：

| 位置 | 取值 |
|---|---|
| 文件名 | `testcases/<lib>/<lib>_<caseNo>.py` |
| Python 类名 | `class <lib>_<caseNo>(TestCase)` |
| 执行参数 | `main.py <lib>_<caseNo>` → `run -l <lib>_<caseNo>` |
| 报告 | `reports/latest/result/<lib>_<caseNo>.xml` |

slug 规则：`-`/`.` → `_`；库名以数字开头时加 `lib_` 前缀；用例号 `C-JS-001` → `C_JS_001`。
例：库 `json-schema` + 用例 `C-JS-001` → `json_schema_C_JS_001`。

**不要用语义名做文件名**（如 `lottieturbo_ImageLoadCallback`）：改用例标题就改文件名，
绑定立刻变 broken、报告也对不上号。语义信息放在脚本头部注释与用例名里。

## 配套的 xdevice 配置（`.json`）

每个 `.py` 必须有一个同名的 `.json`，缺了它框架不知道怎么驱动这个模块：

```json
{
  "description": "<库名> <用例号> <用例名>",
  "environment": [{ "type": "device", "label": "phone" }],
  "driver": { "type": "DeviceTest", "py_file": ["<lib>/<lib>_<caseNo>.py"] }
}
```

- `py_file` 的路径**相对 `testcases/`**；
- 内容变了才重写，保持幂等（内容不变就不动文件，避免无谓的 hash 变化）。

## 绑定状态（区分"能跑"和"看起来能跑"）

| 状态 | 含义 | 优先级 |
|---|---|---|
| `broken` | 脚本文件不存在 | 最高 |
| `manual` | 脚本被人手改过 → **不自动覆盖**（覆盖手写内容是灾难） | 高 |
| `stale` | 用例升版了，脚本还是旧版生成的 → 提示"可能过期" | 中 |
| `fresh` | hash 一致 | 低 |

- Windows/Linux 换行差异**不算**"人为改过"（hash 前统一换行符，否则每次 checkout 都误报）；
- 用例升版时把绑定标 stale，但**不**自动重新生成 —— 让人决定。

## 结果判定（解析运行报告）

**实测的真实报告布局**（xdevice 6.0.7.210）：

```
reports/<时间戳>/summary_report.xml     ← 判定结果看这个（每个模块一条 <testcase>）
reports/<时间戳>/summary_report.html    ← 人看的报告
reports/<时间戳>/details/<module>.html  ← 单模块详情（含截图）
reports/<时间戳>/details/<module>/*.jpeg← 框架自动截的图（失败证据）
reports/<时间戳>/log/<module>/module_run.log, hilog_*
reports/<时间戳>/result/               ← 该目录可能存在但**不一定有** <module>.xml
```

> ⚠️ 常见错误假设：`reports/latest/result/<module>.xml`。实测**这个路径不存在** ——
> 按这个找会导致所有执行都被报成"未找到结果报告"，真正的失败原因（比如设备锁屏）被埋掉。
> 正确做法：找**本次新增**的报告目录 → 优先 `summary_report.xml`，其次 `result/<module>.xml`。

`summary_report.xml` 的关键属性：

```xml
<testsuites failures="1" tests="1" modules="1" runmodules="1">
  <testsuite name="<module>" modulename="<module>">
    <testcase name="<module>" classname="<module>" result="false" time="26.463"
              message="start default mainAbility [EntryAbility] failed. Error Code:10106102 ..." />
  </testsuite>
</testsuites>
```

- `message` 是 **XML 转义过的**（`&#10;` 换行、`&gt;` 等），必须反转义后再展示，否则人看不懂；
- 判定必须**精确匹配模块名**（`classname`/`name` == 模块名）：
  找不到就是"四方一致性"破了 —— **绝不能用别的模块的条目顶替**，那是拿别的用例的结果冒充这一条；
  此时应报"报告里没有模块 X（报告里是：…）"。

| 情况 | 判定 |
|---|---|
| 该模块 `result="true"`，且至少一条断言被校验 | 通过 |
| 通过但断言零校验 | **假通过 → 判失败**（必须回报） |
| `result="false"` 或 `failures>0` | 失败 → 进归因（见 `failure-triage.md`），**把 message 原文带上** |
| 报告里没有该模块 | 失败：四方一致性破了（文件名/类名/`-l` 不一致） |
| 找不到报告目录/文件 | 失败：可能是 hypium/xdevice 没真正跑起来；把输出尾部带上 |
| 用的是上一次的报告 | 失败：执行前记下已有报告目录，只认**本次新增**的那个 |
