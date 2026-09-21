#!/usr/bin/env python3
# coding: utf-8
"""用例文件机械自检（确定性检查，离线可跑，只用标准库）。

它**不判断用例写得好不好**，只检查那些能机械判定的硬性问题：

  1. 表格缺列 / 必填单元格为空
  2. 编号重复
  3. 场景、优先级、可测性取值不在允许集合内
  4. 步骤句式不在白名单内（越界句式无法转成自动化脚本）
  5. 判据缺失、判据里只有含糊值（正常/成功/符合预期…）、恒真断言（assert true / 光秃秃一个 true）
  6. 步骤里出现了验证动作，但判据为空（= 假通过）
  7. 引用了单字符控件（子串匹配会形同虚设，需人工确认是否用全等匹配）
  8. C 类（需改 demo 代码）用例没有留下改造/证据说明

用法：
    python check_cases.py <用例文件.md> [--quiet]

退出码：0 = 没有发现机械性问题；1 = 有问题（逐条列出）；2 = 文件读不了/没找到用例表
"""
import re
import sys

# ---------- 允许集合 ----------

REQUIRED_COLUMNS = ['编号', '接口', '场景', '优先级', '步骤', '判据']

SCENARIO_ALIASES = {
    'happy': 'happy', '正向': 'happy', '正常场景': 'happy',
    'empty': 'empty', '空值': 'empty', '空': 'empty',
    'boundary': 'boundary', '边界': 'boundary', '边界异常': 'boundary', '异常': 'boundary',
    'bigdata': 'bigdata', '大数据': 'bigdata',
}
PRIORITIES = {'P0', 'P1', 'P2'}
TESTABILITY = {'A', 'B', 'C', 'D'}

# 无法核对的含糊期望值（只有当它**单独作为一个取值**时才算违规，
# 所以「操作成功」这种界面上真实出现的文案不会被误判）
VAGUE_VALUES = {
    '正常', '成功', '功能正常', '符合预期', '可用', '没问题', '正常的', '成功了',
    'ok', 'ok了', 'fine', 'works', 'normal', 'success', 'good',
}
# 恒真断言形态：assert true / 光秃秃一个常量（Python 里表达式语句本身没有效果）
TRIVIAL_ASSERT = re.compile(r'^\s*(assert\s+(true|1)\b|true|false|none|pass|1|0|\.\.\.)\s*$', re.I)

STEP_PATTERNS = [
    re.compile(r'^(打开|启动)\s*(应用|app)?$', re.I),
    re.compile(r'^(点击|单击|选中|切换|勾选|长按)\s*「.+?」'),
    # 输入的内容允许为空（空值场景就是要把输入框置空），但目标控件必须有名字
    re.compile(r'^(输入|键入|填写)\s*「(.*?)」\s*(到|至|进入|在)\s*「(.+?)」'),
    re.compile(r'^(等待|停留)\s*约?\s*\d+(\.\d+)?\s*(秒|s|分钟|min)?$', re.I),
    re.compile(r'^(上滑|下滑|向左滑|向右滑|滑动)$'),
    re.compile(r'^(返回|退出|回退)$'),
    re.compile(r'^(验证|断言|检查|确认结果|核对)\s*「.+?」'),
]
VERIFY_STEP = re.compile(r'^(验证|断言|检查|确认结果|核对)')

# 判据里应当出现的类型关键词（英文类型名，或中文的可核对描述）
ORACLE_HINTS = [
    'control_text', 'text_value', 'state_flag', 'hilog_keyword', 'no_crash',
    'screenshot_diff', 'script_assert',
    '界面出现', '界面消失', '控件', '文本包含', '文本等于', '勾选', '开关', '日志',
    '关键字', '错误码', '无崩溃', '截图', '断言', '返回值', '抛出', '异常',
]


def reconfigure_stdout():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def parse_tables(text):
    """抽取所有 Markdown 表格 → [(表头, [行单元格...]), ...]"""
    tables, header, rows = [], None, []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith('|') and line.endswith('|'):
            cells = [c.strip() for c in line.strip('|').split('|')]
            if set(c.replace(' ', '') for c in cells) <= {'', '-'} or all(re.fullmatch(r':?-{2,}:?', c) for c in cells if c):
                continue  # 分隔行
            if header is None:
                header = cells
            else:
                rows.append(cells)
        else:
            if header is not None:
                tables.append((header, rows))
                header, rows = None, []
    if header is not None:
        tables.append((header, rows))
    return tables


def cell(row, header, name):
    if name not in header:
        return ''
    i = header.index(name)
    return row[i].strip() if i < len(row) else ''


def split_steps(s):
    parts = re.split(r'<br\s*/?>|；|;|\n', s)
    return [p.strip() for p in parts if p.strip()]


def quoted_values(s):
    """取出判据/预期里被引号或「」包住的具体取值。"""
    out = []
    for m in re.finditer(r'「([^「」]*)」|"([^"]*)"|\'([^\']*)\'', s):
        v = next((g for g in m.groups() if g is not None), '')
        out.append(v.strip())
    return out


def oracle_value(s):
    """去掉 `类型:` / `type:` 前缀，返回判据里真正的取值部分（用于恒真断言判定）。"""
    return re.sub(r'^\s*[a-z_]+\s*[:：]\s*', '', s.strip(), flags=re.I).strip()


def check_row(row, header, lineno_hint):
    issues = []
    case_no = cell(row, header, '编号')
    interface = cell(row, header, '接口')
    scenario_raw = cell(row, header, '场景')
    priority = cell(row, header, '优先级')
    steps_raw = cell(row, header, '步骤')
    expected = cell(row, header, '预期')
    oracle = cell(row, header, '判据')
    testability = cell(row, header, '可测性')
    evidence = cell(row, header, '证据/关联')
    tag = f'第 {lineno_hint} 行 用例 {case_no or "(无编号)"}'

    if not case_no:
        issues.append(f'{tag}：编号为空')
    if not interface:
        issues.append(f'{tag}：接口为空（每条用例必须挂到一个接口上，否则它无法进入覆盖矩阵）')

    if scenario_raw and scenario_raw not in SCENARIO_ALIASES:
        issues.append(f'{tag}：场景「{scenario_raw}」不在允许集合（happy/empty/boundary/bigdata 或 正向/空值/边界异常/大数据）')
    if priority and priority not in PRIORITIES:
        issues.append(f'{tag}：优先级「{priority}」不在 P0/P1/P2 内')
    if testability and testability not in TESTABILITY:
        issues.append(f'{tag}：可测性「{testability}」不在 A/B/C/D 内')

    if not steps_raw:
        issues.append(f'{tag}：步骤为空')
    else:
        for st in split_steps(steps_raw):
            if not any(p.match(st) for p in STEP_PATTERNS):
                issues.append(f'{tag}：步骤「{st[:32]}」不在句式白名单内（无法转成自动化脚本）')
            for m in re.finditer(r'「([^「」]{1})」', st):
                issues.append(f'{tag}：引用了单字符控件「{m.group(1)}」，子串匹配会形同虚设 —— 需确认用全等匹配')

    # ---- 判据 ----
    if not oracle:
        issues.append(f'{tag}：判据为空 —— 没有可机器校验的判据就是假通过')
    else:
        vals = quoted_values(oracle) + quoted_values(expected)
        vague = [v for v in vals if v.strip().lower() in VAGUE_VALUES]
        if vague:
            issues.append(f'{tag}：判据/预期里含无法核对的含糊取值 {vague}（要写成界面上真正会出现的文本或错误码）')
        if TRIVIAL_ASSERT.match(oracle) or TRIVIAL_ASSERT.match(oracle_value(oracle)):
            issues.append(f'{tag}：判据是恒真断言（{oracle[:24]}），等于没有断言')
        if not any(h in oracle for h in ORACLE_HINTS) and not vals:
            issues.append(f'{tag}：判据没有可识别的判据类型或具体取值（{oracle[:32]}）')

    if VERIFY_STEP.match(split_steps(steps_raw)[0] if steps_raw else '') and not oracle:
        issues.append(f'{tag}：步骤里有验证动作但判据为空（典型假通过形态）')

    if testability == 'C' and not evidence:
        issues.append(f'{tag}：C 类（需改 demo 代码）没有留下改造/证据说明 —— 改完必须验证并写清在哪')
    if testability == 'C' and 'build' not in evidence.lower() and '构建' not in evidence and '截图' not in evidence and 'hilog' not in evidence.lower():
        issues.append(f'{tag}：C 类的证据说明里没提构建/截图/日志 —— 需要能证明"改完真的能触发"')

    return case_no, issues


def main():
    reconfigure_stdout()
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    quiet = '--quiet' in sys.argv
    if not args:
        print('用法：python check_cases.py <用例文件.md> [--quiet]')
        return 2
    path = args[0]
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except Exception as e:
        print(f'读不了文件 {path}：{e}')
        return 2

    tables = parse_tables(text)
    case_tables = [(h, r) for h, r in tables if all(c in h for c in REQUIRED_COLUMNS)]
    if not case_tables:
        print(f'在 {path} 里没找到用例表（表头需同时包含：{"、".join(REQUIRED_COLUMNS)}）')
        print('提示：用例表模板见 references/output-templates.md')
        return 2

    issues, seen, total = [], {}, 0
    for header, rows in case_tables:
        for row in rows:
            total += 1
            case_no, row_issues = check_row(row, header, total + 1)
            if case_no:
                if case_no in seen:
                    row_issues.append(f'用例 {case_no}：编号重复（首次出现在第 {seen[case_no]} 条）')
                else:
                    seen[case_no] = total
            issues.extend(row_issues)

    if not quiet:
        print(f'用例表 {len(case_tables)} 个 · 用例 {total} 条')
    if issues:
        print(f'\n发现 {len(issues)} 个机械性问题：')
        for i, it in enumerate(issues, 1):
            print(f'  {i}. {it}')
        print('\n这些问题必须逐条修掉；修完之后也不代表用例写得好 —— 场景是否适用、'
              '判据是否真能证明接口行为，仍要人工或模型复核。')
        return 1

    print(f'\n机械性检查通过（{total} 条用例）。注意：这只是下限，不代表用例设计得对。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
