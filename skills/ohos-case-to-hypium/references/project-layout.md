# 工程布局与文件归属

## 为什么是单工程多库

`HypiumProjectTemplate` 已经这么定了：一个工程里 `testcases/<lib>/` 按库分目录、
用例名带库前缀、基线按用例名。多库场景下这是**唯一不需要重复维护**的布局。

| 维度 | 单工程多库（选定） | 每库一个工程（否决） |
|---|---|---|
| 骨架（main.py / aw/ / config） | 一份 | N 份，改一处要同步 N 处 |
| 共享能力（等待/滚动/断言/截图） | `aw/` 一处升级，所有库受益 | 漂移成 N 个版本，行为不一致 |
| 报告与基线 | 集中，便于跨库汇总 | 分散，汇总要写额外脚本 |
| 交付单库 | 需要打包 `testcases/<lib>/` | 直接给目录 |
| 隔离风险 | 靠命名空间纪律（见下） | 天然隔离 |

如果确实要单库交付，正确做法是**导出**（复制 `testcases/<lib>/` + 骨架），
而不是平时就维护 N 份工程。

## 文件归属与幂等边界

| 路径 | 谁拥有 | 生成器的行为 |
|---|---|---|
| `main.py`、`run.bat`、`run.sh`、`.gitignore`、`aw/*`、`config/user_config.xml` | **工程骨架**（团队） | **只补缺，绝不覆盖**。手写过的内容必须原样保留 |
| `testcases/<lib>/<lib>_<caseNo>.py` + `.json` | **生成物** | 幂等重写；内容未变则不写（避免 hash 变化把绑定误判为 stale） |
| `resource/baseline/`、`resource/images/` | 素材/基线 | 不生成；框架产 zip 基线，判据产 png 基线，**同一个目录** |
| `reports/`、`tmp_hypium/` | 运行产物 | 不进版本库（`.gitignore` 已含） |

**"只补缺"不是保守，是必须**：有人会在 `aw/Utils.py` 里加机构特有的等待函数、
在 `main.py` 里加自己的日志；被生成器覆盖掉就是灾难。生成器只拥有 `testcases/<lib>/`。

## 三条解耦纪律

1. **跨库复用只能走 `aw/`**：禁止 `from ..other_lib.xxx import`。库之间的依赖会让
   "删掉一个库"变成"删不干净"。
2. **脚本内不许出现设备 sn / 绝对路径 / 库路径**：设备在 `config/user_config.xml`（执行前刷新），
   素材用 `resource/` 相对路径（`os.path.join` 基于 `__file__` 向上找工程根）。
3. **一条用例一个模块**：这样 `-l <module>` 能单跑、报告能逐条对应用例号、失败粒度不丢。
   同一用例内部要重复执行就写循环（压力/稳定性语义），不要靠"多条用例合成一个脚本"。

## 命名契约（四方一致）

```
文件名  = <lib>_<caseNo>.py          # json_schema_C_JS_001.py
类名    = <lib>_<caseNo>             # class json_schema_C_JS_001(TestCase)
-l 参数 = <lib>_<caseNo>             # main.py 里 run -l json_schema_C_JS_001
报告名  = reports/latest/result/<lib>_<caseNo>.xml
```

- 库名 slug：`json-schema` → `json_schema`（`-`/`.` 归一为 `_`）；数字开头补 `lib_` 前缀
  （Python 标识符不能以数字开头）；
- 用例号 slug：`C-JS-001` → `C_JS_001`；
- 为什么用 caseNo 而不是语义名：**改用例标题不会改文件名**，重跑、绑定、报告都不受影响；
  语义名字容易撞名、改名就会把绑定变成 broken。

## 旧布局迁移（每库一个工程 → 单工程）

如果你的工作区里已经有 `hypium/<lib>/`（旧布局），迁移规则：

| 处理 | 对象 |
|---|---|
| **搬走** | `hypium/<lib>/testcases/**` → `hypium/testcases/**` |
| **删除** | 旧骨架里**由工具生成**的已知文件名：`main.py`、`run.bat`、`run.sh`、`.gitignore`、`autotest_oracle.py` |
| **保留** | 其他一切文件（同事写的 README、自定义脚本、素材）——**目录里有这些东西就整个留着** |
| 收尾 | 只删空目录；非空目录原样保留 |

迁移是幂等的，可以反复跑。平台侧 `ensureHypiumProject()` 每次都会顺手做一次。

## 多库并发的注意事项

单工程意味着 `config/user_config.xml`（设备 sn）是共享的。执行时**每条用例执行前刷新 sn**，
所以"同一时刻只跑一台设备"是硬约束：

- 同时跑两个库、两台设备 → sn 会互相覆盖，其中一条会跑错设备；
- 要并行就先按设备复制工程，或给每条用例传设备参数（`--device` 一类的机制由执行器控制）。

这条要在报告里如实说明，不要假装支持并发。
