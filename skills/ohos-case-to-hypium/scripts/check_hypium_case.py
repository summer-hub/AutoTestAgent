#!/usr/bin/env python3
# coding: utf-8
"""Hypium 用例脚本静态自检（纯标准库，可离线跑）。

它只做**确定性**检查 —— 不能判断用例设计得好不好，但以下问题一旦存在，脚本必然不可靠：

  1. 语法编译不过（连跑都跑不起来）
  2. 类名 ≠ 模块名（xdevice `-l <module>` 加载不到，报告里也不会出现该模块）
  3. 没有任何断言（假通过：跑通了也说明不了任何事）
  4. 断言恒真（`assert true`、裸 `true`/`1`）
  5. 调用了**不存在**的 driver API（例如 `driver.assert_component_exist`，实测 hypium 里没有）
  6. 判据断言模块的 import 路径不对（应为 `from aw.autotest_oracle import ...`）
  7. 步骤被写成注释行冒充（该执行的没执行，报告却是绿的）
  8. `.py` 没有配对的 `.json`，或 json 的 `driver.py_file` 指向错误（框架不知道该怎么驱动）

用法：
    python check_hypium_case.py <脚本.py>            # 单文件
    python check_hypium_case.py <testcases/<lib>>    # 目录模式：批量 + 成对校验

退出码：0 = 无机械性问题；1 = 有问题；2 = 参数/读取失败
"""
import json
import os
import re
import py_compile
import sys
import tempfile

# 本机实测核实存在的 hypium UiDriver 方法（对着 site-packages/hypium 全包核对过）
VERIFIED_DRIVER_API = {
    'wait_for_component', 'wait_for_component_disappear', 'get_component_property', 'current_app',
    'shell', 'hdc', 'capture_screen', 'take_screenshot', 'find_component', 'find_all_components',
    'touch', 'input_text', 'clear_text', 'swipe', 'swipe_to_back', 'slide', 'fling', 'drag',
    'press_key', 'press_back', 'press_home', 'go_back', 'go_home', 'wait', 'start_app', 'stop_app',
    'has_app', 'install_app', 'uninstall_app', 'get_display_size', 'get_window_size', 'log', 'config',
}
# 明确不存在但历史上被生成过的方法（旧生成器用过，属运行期 AttributeError）
KNOWN_MISSING_API = {'assert_component_exist'}
TRIVIAL_ASSERT = re.compile(r'^\s*(assert\s+(true|1)\b|true|false|none|pass|1|0|\.\.\.)\s*$', re.I)
ASSERT_CALL = re.compile(r'\bassert_[a-z_]+\s*\(|^\s*assert\s+\S', re.M)
COMMENT_STEP = re.compile(r"^\s*#\s*\d+[.、]\s*.+$", re.M)


def reconfigure_stdout():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def check_script(path):
    issues = []
    name = os.path.basename(path)
    try:
        with open(path, encoding='utf-8') as f:
            src = f.read()
    except Exception as e:
        return [f'{name}: 读不了文件（{e}）']

    module = os.path.splitext(name)[0]

    # 1. 语法
    try:
        with tempfile.TemporaryDirectory() as td:
            py_compile.compile(path, cfile=os.path.join(td, 'x.pyc'), doraise=True)
    except py_compile.PyCompileError as e:
        issues.append(f'{name}: 语法错误 —— {str(e).splitlines()[-1][:160]}')

    # 2. 类名 = 模块名
    class_names = re.findall(r'^class\s+(\w+)\s*\(', src, re.M)
    if not class_names:
        issues.append(f'{name}: 没找到 TestCase 类')
    elif module not in class_names:
        issues.append(f'{name}: 类名 {class_names} 与模块名 {module} 不一致 —— '
                      f'xdevice 用 `run -l {module}` 加载，类名必须与之一致')

    # 3. 断言存在
    if not ASSERT_CALL.search(src):
        issues.append(f'{name}: 脚本里没有任何断言 —— 假通过（跑通了也说明不了任何事）')

    # 4. 恒真断言
    for line in src.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            continue
        if TRIVIAL_ASSERT.match(stripped) or TRIVIAL_ASSERT.match(re.sub(r'^\w+\s*[:=]\s*', '', stripped)):
            issues.append(f'{name}: 恒真断言 `{stripped[:40]}`（等于没有断言）')
            break

    # 5. driver API 白名单
    called = set(re.findall(r'self\.driver\.([a-zA-Z_]\w*)\s*\(', src))
    missing = sorted(called & KNOWN_MISSING_API)
    if missing:
        issues.append(f'{name}: 使用了 hypium 里**不存在**的 API {missing}（历史生成器踩过：整条用例必然报错）')
    unknown = sorted(called - VERIFIED_DRIVER_API - KNOWN_MISSING_API)
    if unknown:
        issues.append(f'{name}: 调用了未核实的 driver API {unknown} —— '
                      f'这些方法在 hypium 包里不存在或未经核实（会运行期 AttributeError）')

    # 6. 判据模块 import 路径
    if 'autotest_oracle' in src and 'from aw.autotest_oracle import' not in src:
        issues.append(f'{name}: 判据断言模块的 import 路径不对 —— 应为 `from aw.autotest_oracle import (...)`'
                      f'（模块归位共享 aw/ 包，不再放工程根）')

    # 7. 注释行冒充步骤
    fake = COMMENT_STEP.findall(src)
    if fake:
        issues.append(f'{name}: 有 {len(fake)} 行像步骤的注释（如 `{fake[0].strip()[:36]}`）—— '
                      f'无法映射的步骤必须报错，不能用注释行让脚本"看起来正常"')

    return issues


def check_pairs(lib_dir):
    """成对校验：每个 .py 要有同名 .json，且 driver.py_file 指向自己。"""
    issues = []
    pys = sorted(f for f in os.listdir(lib_dir) if f.endswith('.py'))
    jsons = sorted(f for f in os.listdir(lib_dir) if f.endswith('.json'))
    lib_slug = os.path.basename(os.path.normpath(lib_dir))
    for py in pys:
        stem = py[:-3]
        partner = f'{stem}.json'
        if partner not in jsons:
            issues.append(f'{py}: 缺少配对的 {partner}（xdevice 驱动配置缺了就跑不起来）')
            continue
        try:
            with open(os.path.join(lib_dir, partner), encoding='utf-8') as f:
                cfg = json.load(f)
        except Exception as e:
            issues.append(f'{partner}: 不是合法 JSON（{e}）')
            continue
        py_file = (cfg.get('driver') or {}).get('py_file')
        expected = f'{lib_slug}/{py}'
        if py_file != [expected]:
            issues.append(f'{partner}: driver.py_file = {py_file!r}，应为 [{expected!r}]（相对 testcases/）')
        if not cfg.get('environment'):
            issues.append(f'{partner}: 缺 environment（模板里是 [{{"type":"device","label":"phone"}}]）')
    for js in jsons:
        if f'{js[:-5]}.py' not in pys:
            issues.append(f'{js}: 没有配对的 .py（孤儿配置）')
    for py in pys:
        issues.extend(check_script(os.path.join(lib_dir, py)))
    return issues, len(pys)


def main():
    reconfigure_stdout()
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print('用法：python check_hypium_case.py <脚本.py 或 testcases/<lib> 目录>')
        return 2
    target = args[0]
    if os.path.isdir(target):
        issues, n = check_pairs(target)
        print(f'目录 {target}：{n} 个脚本')
    elif os.path.isfile(target):
        issues = check_script(target)
        print(f'脚本 {os.path.basename(target)}')
    else:
        print(f'路径不存在：{target}')
        return 2

    if issues:
        print(f'\n发现 {len(issues)} 个机械性问题：')
        for i, it in enumerate(issues, 1):
            print(f'  {i}. {it}')
        print('\n这些问题必须逐条修掉；修完也不代表用例写得好 —— '
              '步骤是否真能执行、判据是否真能证明接口行为，仍要在真机上验证。')
        return 1
    print('\n机械性检查通过。注意：这只是下限，真机 dry-run 才算数。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
