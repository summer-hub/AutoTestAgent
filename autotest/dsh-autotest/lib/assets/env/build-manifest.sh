#!/usr/bin/env bash
# 读取并校验工程清单（envkit 脚本资产：build_manifest · POSIX 侧）
#
# 与 build-manifest.ps1 同一份契约（src/services/envkit/builtin.ts::build_manifest）。
# bundleName / module / apiLevel 是后续构建、装包、真机遍历、执行的公共输入，
# 提前归一化成一份 JSON，后续步骤不必各自解析 JSON5 的细节差异。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：读不到就明说读不到——manifest 缺失是重要失败，绝不返回"猜出来的"清单。
set -uo pipefail

PROJECT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    *) echo "[build_manifest] 未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]]; then
  echo "[build_manifest] 工程目录不存在：$PROJECT_DIR" >&2
  exit 2
fi

BUILD_PROFILE="$PROJECT_DIR/build-profile.json5"
OH_PACKAGE="$PROJECT_DIR/oh-package.json5"

if [[ ! -f "$BUILD_PROFILE" && ! -f "$OH_PACKAGE" ]]; then
  echo "[build_manifest] 未找到 build-profile.json5 或 oh-package.json5：$PROJECT_DIR" >&2
  exit 1
fi

MANIFEST_DIR="$PROJECT_DIR/.autotest-env"
MANIFEST_PATH="$MANIFEST_DIR/manifest.json"
mkdir -p "$MANIFEST_DIR" || exit 2

# 用 node 做 JSON5 宽松解析：注释/尾逗号容忍，失败时给出行号。
# 选 node 而不是 python/sed：工程环境里 node 必然存在（ohpm/hvigorw 生态），
# 且 JSON 处理不会因为引号转义踩坑。
BUNDLE_NAME=""
MODULE_NAME=""
API_LEVEL=""
VERSION_NAME=""

if [[ -f "$BUILD_PROFILE" ]]; then
  eval "$(node -e '
    const fs = require("fs");
    const f = process.argv[1];
    let raw = fs.readFileSync(f, "utf8");
    raw = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1");
    let o; try { o = JSON.parse(raw); } catch (e) { console.error("PARSE_ERR=" + e.message); process.exit(0); }
    const app = o.app || {};
    const products = (app.products || [])[0] || {};
    const mods = (o.modules || []).map(m => m.name).filter(Boolean);
    const out = {
      bundleName: app.bundleName || "",
      apiLevel: String(products.targetSdkVersion || ""),
      modules: mods,
    };
    for (const [k, v] of Object.entries(out)) console.log(`MF_${k}=${JSON.stringify(v)}`);
  ' "$BUILD_PROFILE" 2>/dev/null)" || true
fi

if [[ -f "$OH_PACKAGE" ]]; then
  eval "$(node -e '
    const fs = require("fs");
    let raw = fs.readFileSync(process.argv[1], "utf8");
    raw = raw.replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
    let o; try { o = JSON.parse(raw); } catch (e) { process.exit(0); }
    if (o.name) console.log(`OP_NAME=${JSON.stringify(o.name)}`);
    if (o.version) console.log(`OP_VERSION=${JSON.stringify(o.version)}`);
  ' "$OH_PACKAGE" 2>/dev/null)" || true
fi

[[ -n "${MF_bundleName:-}" && "$MF_bundleName" != '""' ]] && BUNDLE_NAME="$MF_bundleName"
[[ -n "${MF_apiLevel:-}" && "$MF_apiLevel" != '""' ]] && API_LEVEL="$MF_apiLevel"
[[ -n "${OP_NAME:-}" && "$OP_NAME" != '""' ]] && MODULE_NAME="$OP_NAME"
[[ -n "${OP_VERSION:-}" && "$OP_VERSION" != '""' ]] && VERSION_NAME="$OP_VERSION"

if [[ -z "$BUNDLE_NAME" ]]; then
  echo "[build_manifest] 未解析到 bundleName（检查 build-profile.json5 的 app.bundleName）" >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const out = {
    projectDir: process.argv[1], bundleName: process.argv[2], moduleName: process.argv[3],
    apiLevel: process.argv[4], versionName: process.argv[5], modules: [],
  };
  fs.writeFileSync(process.argv[6], JSON.stringify(out, null, 2));
' "$PROJECT_DIR" "$BUNDLE_NAME" "$MODULE_NAME" "$API_LEVEL" "$VERSION_NAME" "$MANIFEST_PATH" || exit 1

echo "[build_manifest] bundleName=$BUNDLE_NAME module=$MODULE_NAME apiLevel=$API_LEVEL"
echo "MANIFEST_PATH=$MANIFEST_PATH"
echo "BUNDLE_NAME=$BUNDLE_NAME"
exit 0
