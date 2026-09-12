# coding: utf-8
"""判据支持模块的运行期校验夹具（真机无关）。

它把 AutoTest 生成的 autotest_oracle.py 真正 import 进来，并用一个**假 driver**
逐条触发每个断言函数，检查两件事：
  ① 该通过的必须通过（不误报失败）；
  ② 该失败的必须抛 TestAssertionError（**绝不静默通过** —— 静默通过就是假通过）。

只输出 ASCII JSON（避免 Windows 控制台编码问题），由 verify-oracle-runtime.mjs 汇总成中文报告。
用法：python hypium-oracle-harness.py <autotest_oracle.py 路径> <临时工作目录>
"""
import importlib.util
import json
import os
import re
import sys

RESULT = {"checks": [], "errors": []}


def record(name, ok, detail=""):
    RESULT["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})


def load_module(path):
    spec = importlib.util.spec_from_file_location("autotest_oracle_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Comp(object):
    def __init__(self, text):
        self.text = text


class FakeDriver(object):
    """按需假装出的 UiDriver：只实现支持模块真正调用的那几个方法。"""

    def __init__(self, texts=(), pkg="com.demo.lib", logs="", screen_color=None):
        self.texts = set(texts)
        self.pkg = pkg
        self.logs = logs
        self.screen_color = screen_color
        self.current_app_ok = True
        self.disappear_noop = False  # True = 假装"消失成功"但仍留在界面上（用于验证二次复核）

    @staticmethod
    def _text_of(by):
        # By 对象的 repr 是 "By_unresolved#N"，文本在 match_value 里（str() 才是 BY.text('x')）
        v = getattr(by, "match_value", None)
        if v is not None:
            return v
        m = re.search(r"text\((['\"])(.*?)\1\)", str(by))
        return m.group(2) if m else None

    def wait_for_component(self, by, timeout=10):
        t = self._text_of(by)
        return Comp(t) if t in self.texts else None

    def wait_for_component_disappear(self, by, timeout=10):
        # 真实实现超时会抛异常；这里用 noop 模拟"框架说消失成功"，交给支持模块自己复核
        if not self.disappear_noop:
            t = self._text_of(by)
            if t in self.texts:
                raise Exception("timeout waiting for %s to disappear" % t)
        return None

    def get_component_property(self, component, property_name):
        if property_name == "text":
            return getattr(component, "text", "")
        if property_name == "checked":
            return getattr(component, "checked", False)
        return None

    def current_app(self):
        if not self.current_app_ok:
            return (None, None)
        return (self.pkg, self.pkg + ".MainAbility")

    def shell(self, cmd, timeout=60):
        return self.logs

    def capture_screen(self, save_path, in_pc=True, area=None):
        from PIL import Image
        Image.new("RGB", (40, 40), self.screen_color or (0, 0, 0)).save(save_path)
        return save_path


def expect_pass(name, fn):
    try:
        fn()
        record(name, True, "no exception")
    except Exception as e:  # noqa: BLE001
        record(name, False, "unexpected %s: %s" % (type(e).__name__, e))


def expect_raise(mod, name, fn, needle=""):
    try:
        fn()
        record(name, False, "NO exception raised (silent pass!)")
    except mod.TestAssertionError as e:
        ok = (needle in str(e)) if needle else True
        record(name, ok, "%s: %s" % (type(e).__name__, e))
    except Exception as e:  # noqa: BLE001
        record(name, False, "raised %s (not TestAssertionError): %s" % (type(e).__name__, e))


def main():
    mod_path = sys.argv[1]
    workdir = sys.argv[2]
    baseline = os.path.join(workdir, "baselines")
    os.environ["AUTOTEST_BASELINE_DIR"] = baseline
    mod = load_module(mod_path)

    # 1. control_text
    expect_pass("control_text 出现且存在 -> 通过", lambda: mod.assert_control_text(FakeDriver(["结果：true"]), "结果：true"))
    expect_raise(mod, "control_text 出现但不存在 -> 抛错", lambda: mod.assert_control_text(FakeDriver([]), "结果：true"), "未找到控件")
    expect_pass("control_text 消失且确已消失 -> 通过", lambda: mod.assert_control_text(FakeDriver([]), "加载中", expect="disappear"))
    d = FakeDriver(["加载中"])
    d.disappear_noop = True  # 框架假装成功，但控件还在
    expect_raise(mod, "control_text 消失但控件仍在 -> 抛错（复核拦截静默通过）", lambda: mod.assert_control_text(d, "加载中", expect="disappear"), "未按要求消失")

    # 2. text_value
    expect_pass("text_value contains 命中 -> 通过", lambda: mod.assert_text_value(FakeDriver(["实际结果：true"]), "实际结果：true", "contains", "true"))
    expect_raise(mod, "text_value contains 不命中 -> 抛错", lambda: mod.assert_text_value(FakeDriver(["实际结果：false"]), "实际结果：false", "contains", "true"), "不符合预期")
    expect_pass("text_value equals 命中 -> 通过", lambda: mod.assert_text_value(FakeDriver(["42"]), "42", "equals", "42"))
    expect_raise(mod, "text_value equals 不命中 -> 抛错", lambda: mod.assert_text_value(FakeDriver(["42"]), "42", "equals", "43"))
    expect_pass("text_value matches 命中 -> 通过", lambda: mod.assert_text_value(FakeDriver(["V1.2.3"]), "V1.2.3", "matches", r"V\d+\.\d+"))
    expect_raise(mod, "text_value 控件不存在 -> 抛错", lambda: mod.assert_text_value(FakeDriver([]), "结果", "equals", "1"))

    # 3. state_flag
    c = Comp("开关")
    c.checked = True
    drv = FakeDriver(["开关"])
    drv.get_component_property = lambda component, prop: True if prop == "checked" else None
    expect_pass("state_flag 勾选状态一致 -> 通过", lambda: mod.assert_state_flag(drv, "开关", True))
    drv2 = FakeDriver(["开关"])
    drv2.get_component_property = lambda component, prop: False if prop == "checked" else None
    expect_raise(mod, "state_flag 勾选状态不一致 -> 抛错", lambda: mod.assert_state_flag(drv2, "开关", True), "勾选状态不符")

    # 4. hilog_keyword
    expect_pass("hilog 含关键字 -> 通过", lambda: mod.assert_hilog_keyword(FakeDriver(logs="08-01 10:00:00 1 1 I json: validate ok"), "validate ok"))
    expect_raise(mod, "hilog 不含关键字 -> 抛错", lambda: mod.assert_hilog_keyword(FakeDriver(logs="nothing here"), "validate ok"), "未出现关键字")

    # 5. no_crash
    clean = "08-01 10:00:00 100 100 I C02d00/com.demo.lib: all good"
    dirty = "08-01 10:00:00 100 100 E C02d00/com.demo.lib: boom"
    expect_pass("no_crash 前台正常、无 E 级日志 -> 通过", lambda: mod.assert_no_crash(FakeDriver(logs=clean), "com.demo.lib"))
    expect_raise(mod, "no_crash 日志出现该应用 E 级错误 -> 抛错", lambda: mod.assert_no_crash(FakeDriver(logs=dirty), "com.demo.lib"), "E 级错误")
    expect_raise(mod, "no_crash 应用已不在前台 -> 抛错", lambda: mod.assert_no_crash(FakeDriver(pkg="com.other.app", logs=clean), "com.demo.lib"), "不在前台")
    bad_app = FakeDriver(logs=clean)
    bad_app.current_app_ok = False
    expect_raise(mod, "no_crash 读不到前台应用 -> 抛错（无法判定就不能算通过）", lambda: mod.assert_no_crash(bad_app, "com.demo.lib"), "无法判定")

    # 6. screenshot_diff：首次运行存基线并判失败
    expect_raise(mod, "截图首次运行 -> 存基线并抛错（不静默通过）", lambda: mod.assert_screenshot_diff(FakeDriver(screen_color=(10, 20, 30)), 0.05, "case1"), "首次运行")
    record("截图首次运行确实落盘了基线文件", os.path.exists(os.path.join(baseline, "case1.png")), os.listdir(baseline) if os.path.isdir(baseline) else "no dir")
    expect_pass("截图与基线一致 -> 通过", lambda: mod.assert_screenshot_diff(FakeDriver(screen_color=(10, 20, 30)), 0.05, "case1"))
    expect_raise(mod, "截图与基线不一致 -> 抛错", lambda: mod.assert_screenshot_diff(FakeDriver(screen_color=(200, 200, 200)), 0.05, "case1"), "超过阈值")

    # 7. 生成的用例脚本本身：能否被 devicetest 导入（方法/参数名写错在这里就会炸）
    sys.path.insert(0, workdir)
    try:
        import importlib
        case = importlib.import_module("gen_case_probe")
        classes = [c for c in dir(case) if c.startswith("Case_")]
        record("生成的用例脚本可被 import（devicetest/hypium 依赖齐全）", len(classes) == 1, "classes=%s" % classes)
        from devicetest.core.test_case import TestCase
        record("生成的用例类是 devicetest TestCase 子类", bool(classes) and issubclass(getattr(case, classes[0]), TestCase))
    except Exception as e:  # noqa: BLE001
        record("生成的用例脚本可被 import（devicetest/hypium 依赖齐全）", False, "%s: %s" % (type(e).__name__, e))

    json.dump(RESULT, sys.stdout, ensure_ascii=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        RESULT["errors"].append(traceback.format_exc()[-800:])
        json.dump(RESULT, sys.stdout, ensure_ascii=True)
        sys.exit(0)
