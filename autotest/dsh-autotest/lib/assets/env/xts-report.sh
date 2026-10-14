#!/usr/bin/env bash
# 解析 XTS 报告成平台统一执行记录（envkit 脚本资产：xts_report · POSIX 侧）
#
# 与 xts-report.ps1 同一份契约（src/services/envkit/builtin.ts::xts_report）。
# XTS 的报告格式（xml/json/html 混杂、设备 pull 下来目录结构不一）与平台的执行记录
# 是两套语义。不收敛的话，"这次 XTS 跑得怎么样"永远要看原始报告。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · 解析不出结构化结果不是失败——至少产出"报告存在但无法解析"的摘要并如实标注；
#   · 摘要必须区分 total / passed / failed / blocked / ignored 五态（XTS 标准语义）；
#   · reportSource 如实透出，不把退化来源假装成标准报告。
set -uo pipefail

REPORT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -reportDir|--report-dir) REPORT_DIR="$2"; shift 2 ;;
    *) echo "[xts_report] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$REPORT_DIR" || ! -d "$REPORT_DIR" ]] && { echo "[xts_report] 报告目录不存在：$REPORT_DIR" >&2; exit 1; }

# ---- 收集报告文件 ----
mapfile -t FILES < <(find "$REPORT_DIR" -type f \( -name '*.xml' -o -name '*.json' -o -name '*.html' -o -name '*.log' \) 2>/dev/null)
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "[xts_report] 报告目录里没有可解析文件：$REPORT_DIR" >&2
  exit 1
fi

META_FILE="$REPORT_DIR/run-meta.json"
MODULE=""; BUNDLE_NAME=""; SERIAL=""; REPORT_SOURCE="unknown"
if [[ -f "$META_FILE" ]]; then
  MODULE=$(node -e 'try{const o=require(process.argv[1]);console.log(o.module||"")}catch{console.log("")}' "$META_FILE" 2>/dev/null || echo "")
  BUNDLE_NAME=$(node -e 'try{const o=require(process.argv[1]);console.log(o.bundleName||"")}catch{console.log("")}' "$META_FILE" 2>/dev/null || echo "")
  SERIAL=$(node -e 'try{const o=require(process.argv[1]);console.log(o.serial||"")}catch{console.log("")}' "$META_FILE" 2>/dev/null || echo "")
  REPORT_SOURCE=$(node -e 'try{const o=require(process.argv[1]);console.log(o.reportSource||"unknown")}catch{console.log("unknown")}' "$META_FILE" 2>/dev/null || echo "unknown")
fi

# ---- 解析 XTS 结果 ----
# XTS 标准结果文件是 Tests.xml（每个 TestCase 一个 <TestCase> 节点，Result 属性为
# Pass/Fail/Blocked/Ignore）。用 node 做最小可用解析：数节点 + 读 Result 属性。
# 选 node 而不是 grep/sed：XML 属性解析用正则容易在多行/属性顺序变化时出错。
PARSE_RESULT=$(node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
let total=0, passed=0, failed=0, blocked=0, ignored=0, structured=false;
const cases=[];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".xml")) continue;
    let text; try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    // 只认含 TestCase 节点的文件（XTS 标准结果）
    if (!/<TestCase[\s>]/.test(text)) continue;
    structured = true;
    const re = /<TestCase\b([^>]*)>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const attrs = m[1];
      const r = /Result\s*=\s*"([^"]*)"/i.exec(attrs);
      const n = /Name\s*=\s*"([^"]*)"/i.exec(attrs);
      const result = r ? r[1] : "";
      total++;
      switch (result.toLowerCase()) {
        case "pass": passed++; break;
        case "fail": failed++; break;
        case "blocked": blocked++; break;
        default: ignored++; break;
      }
      cases.push({ name: n ? n[1] : "", result });
    }
  }
};
walk(dir);
console.log(JSON.stringify({ total, passed, failed, blocked, ignored, structured, cases }));
' "$REPORT_DIR" 2>/dev/null) || PARSE_RESULT=""

TOTAL=0; PASSED=0; FAILED=0; BLOCKED=0; IGNORED=0; STRUCTURED=false
if [[ -n "$PARSE_RESULT" ]]; then
  read -r TOTAL PASSED FAILED BLOCKED IGNORED STRUCTURED <<< "$(node -e '
const o=JSON.parse(process.argv[1]);
console.log(o.total, o.passed, o.failed, o.blocked, o.ignored, o.structured);
' "$PARSE_RESULT" 2>/dev/null)"
fi

PASS_RATE=0
if [[ "$TOTAL" -gt 0 ]]; then PASS_RATE=$(node -e "console.log(Math.round($PASSED/$TOTAL*10000)/10000)"); fi

# ---- 产出归一化摘要 ----
SUMMARY_PATH="$REPORT_DIR/xts-summary.json"
NOTE=""
if [[ "$STRUCTURED" != "true" ]]; then
  NOTE='未解析出结构化用例结果（报告可能是原始日志或非标准格式），请查看原始报告'
fi

node -e '
const fs=require("fs");
const summary={
  reportDir: process.argv[1], reportSource: process.argv[2], structured: process.argv[3]==="true",
  total: Number(process.argv[4]), passed: Number(process.argv[5]), failed: Number(process.argv[6]),
  blocked: Number(process.argv[7]), ignored: Number(process.argv[8]),
  passRate: Number(process.argv[9]), module: process.argv[10], bundleName: process.argv[11],
  serial: process.argv[12], cases: JSON.parse(process.argv[13]||"[]"), note: process.argv[14],
  at: new Date().toISOString(),
};
fs.writeFileSync(process.argv[15], JSON.stringify(summary, null, 2));
' "$REPORT_DIR" "$REPORT_SOURCE" "$STRUCTURED" "$TOTAL" "$PASSED" "$FAILED" "$BLOCKED" "$IGNORED" \
  "$PASS_RATE" "$MODULE" "$BUNDLE_NAME" "$SERIAL" "$PARSE_RESULT" "$NOTE" "$SUMMARY_PATH" \
  || { echo "[xts_report] 写摘要失败" >&2; exit 1; }

echo "[xts_report] total=$TOTAL passed=$PASSED failed=$FAILED blocked=$BLOCKED ignored=$IGNORED structured=$STRUCTURED"
echo "XTS_TOTAL=$TOTAL"
echo "XTS_PASSED=$PASSED"
echo "XTS_FAILED=$FAILED"
echo "SUMMARY_PATH=$SUMMARY_PATH"

# 有失败用例不是步骤失败（报告解析成功了）——由平台按用例维度判通过率
exit 0
