#!/usr/bin/env bash
# 把三方库接进 XTS 测试工程（envkit 脚本资产：xts_scaffold · POSIX 侧）
#
# 与 xts-scaffold.ps1 同一份契约（src/services/envkit/builtin.ts::xts_scaffold）。
# XTS（ActsTest）是鸿蒙的系统级兼容性测试套件，三方库接入它可用官方框架
# 验证库在真机上的真实兼容性，而不只是跑自己的 demo。
#
# ⚠️ 边界（刻意收窄）：只做 scaffold —— 生成测试模块骨架，**不生成测试用例**。
#    用例生成是另一个产品问题，混在一起会让这一步不可验证。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · 幂等：模块已存在且标记完整则跳过（不重复覆盖人已补的用例）；
#   · 产物必须真存在；
#   · 骨架必须能过 ArkTS 严格模式（否则 xts_run 在编译期失败，根因却是骨架不规范）。
set -uo pipefail

PROJECT_DIR=""; LIBRARY_NAME=""; BUNDLE_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -projectDir|--project-dir) PROJECT_DIR="$2"; shift 2 ;;
    -libraryName|--library-name) LIBRARY_NAME="$2"; shift 2 ;;
    -bundleName|--bundle-name) BUNDLE_NAME="$2"; shift 2 ;;
    *) echo "[xts_scaffold] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]] && { echo "[xts_scaffold] 工程目录不存在：$PROJECT_DIR" >&2; exit 2; }
[[ -n "$LIBRARY_NAME" ]] || { echo "[xts_scaffold] libraryName 必填" >&2; exit 1; }

# 模块名：库名转合法标识符（XTS 模块名要求小写字母开头 + 字母数字下划线）
MODULE_NAME=$(echo "$LIBRARY_NAME" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9_' '_' | sed 's/^_*//;s/_*$//')
if [[ ! "$MODULE_NAME" =~ ^[a-z][a-z0-9_]*$ ]]; then MODULE_NAME="xts_${MODULE_NAME}"; fi
MODULE_DIR="$PROJECT_DIR/$MODULE_NAME"
MARKER="$MODULE_DIR/.autotest-xts-scaffold"

echo "[xts_scaffold] projectDir=$PROJECT_DIR library=$LIBRARY_NAME module=$MODULE_NAME"

# ---- 幂等：已存在且标记完整 → 跳过 ----
if [[ -d "$MODULE_DIR" && -f "$MARKER" ]]; then
  echo "[xts_scaffold] 模块已存在且标记完整，跳过（幂等）：$MODULE_DIR"
  echo "TEST_MODULE_DIR=$MODULE_DIR"
  exit 0
fi

mkdir -p "$MODULE_DIR/src/main/ets/test" "$MODULE_DIR/src/main/resources/base/profile" || {
  echo "[xts_scaffold] 创建模块目录失败" >&2; exit 1; }

# ---- oh-package.json5 ----
cat > "$MODULE_DIR/oh-package.json5" <<EOF
{
  "name": "$MODULE_NAME",
  "version": "1.0.0",
  "description": "XTS test module for $LIBRARY_NAME (scaffolded by AutoTest)",
  "dependencies": {}
}
EOF

# ---- build-profile.json5 ----
cat > "$MODULE_DIR/build-profile.json5" <<'EOF'
{
  "moduleType": "feature",
  "targets": [
    {
      "name": "default",
      "applyToProducts": ["default"]
    }
  ]
}
EOF

# ---- 测试入口（ArkTS 严格模式合规：无 any、显式类型、分号结尾）----
cat > "$MODULE_DIR/src/main/ets/test/List.test.ets" <<EOF
import { describe, expect, it } from '@ohos/hypium';

/**
 * XTS 测试骨架（AutoTest scaffold，不含用例）。
 * 用例由用例流水线或人工补充；补完后跑 xts_run。
 */
export default function ${MODULE_NAME}Test(): void {
  describe('${LIBRARY_NAME}Xts', () => {
    it('scaffold_ready', 0, () => {
      expect(1).assertEqual(1);
    });
  });
}
EOF

# ---- 标记文件（幂等判据）----
cat > "$MARKER" <<EOF
{
  "libraryName": "$LIBRARY_NAME",
  "bundleName": "$BUNDLE_NAME",
  "moduleName": "$MODULE_NAME",
  "scaffoldVersion": "1.0.0",
  "note": "AutoTest XTS scaffold: skeleton only, no test cases"
}
EOF

# ---- 产物校验 ----
[[ -d "$MODULE_DIR" ]] || { echo "[xts_scaffold] 模块目录未生成：$MODULE_DIR" >&2; exit 1; }
for f in "oh-package.json5" "build-profile.json5" "src/main/ets/test/List.test.ets"; do
  [[ -f "$MODULE_DIR/$f" ]] || { echo "[xts_scaffold] 骨架文件缺失：$f" >&2; exit 1; }
done

echo "[xts_scaffold] 完成：$MODULE_DIR（骨架就绪，用例待补）"
echo "TEST_MODULE_DIR=$MODULE_DIR"
exit 0
