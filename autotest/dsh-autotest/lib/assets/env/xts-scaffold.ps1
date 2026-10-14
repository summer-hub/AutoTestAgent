# 把三方库接进 XTS 测试工程（envkit 脚本资产：xts_scaffold）
#
# 契约见 src/services/envkit/builtin.ts::xts_scaffold。
# XTS（ActsTest）是鸿蒙的系统级兼容性测试套件。三方库接入 XTS 的意义：
# 用官方测试框架验证库在真机上的真实兼容性，而不是只跑自己的 demo。
#
# ⚠️ 边界（刻意收窄，见重构方案 R4）：本步骤只做 **scaffold**——生成测试模块骨架，
# **不生成测试用例**。用例生成是另一个产品问题（需要接口面 + 场景设计），
# 混在一起会让这一步变得不可验证。生成后可人工或用例流水线补用例，再跑 xts_run。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 幂等：模块已存在且结构完整则跳过（不重复覆盖人已补的用例）；
#   · 产物必须真存在：testModuleDir 必须 stat 到；
#   · 生成的骨架必须能过 ArkTS 严格模式（否则 xts_run 直接在编译期失败，
#     而失败信息指向"编译错误"，根因却是骨架不规范）。
param(
  [Parameter(Mandatory=$true)][string]$projectDir,
  [Parameter(Mandatory=$true)][string]$libraryName,
  [string]$bundleName = ""
)

$ErrorActionPreference = "Stop"
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $projectDir)) {
  & $script:Missing "[xts_scaffold] 工程目录不存在：$projectDir"
}
if (-not $libraryName) { & $script:Fail "[xts_scaffold] libraryName 必填" }

# 模块名：库名转合法标识符（XTS 模块名要求字母数字下划线）
$moduleName = ($libraryName -replace '[^a-zA-Z0-9_]', '_').ToLower()
if ($moduleName -notmatch '^[a-z][a-z0-9_]*$') { $moduleName = "xts_$moduleName" }
$moduleDir = Join-Path $projectDir $moduleName

Write-Output "[xts_scaffold] projectDir=$projectDir library=$libraryName module=$moduleName"

# ---- 幂等：已存在且结构完整 → 跳过 ----
$marker = Join-Path $moduleDir ".autotest-xts-scaffold"
if ((Test-Path -LiteralPath $moduleDir) -and (Test-Path -LiteralPath $marker)) {
  Write-Output "[xts_scaffold] 模块已存在且标记完整，跳过（幂等）：$moduleDir"
  Write-Output "TEST_MODULE_DIR=$moduleDir"
  exit 0
}

try {
  New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $moduleDir "src" "main" "ets" "test") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $moduleDir "src" "main" "resources" "base" "profile") | Out-Null
} catch {
  & $script:Fail "[xts_scaffold] 创建模块目录失败：$($_.Exception.Message)"
}

# ---- oh-package.json5（测试模块的依赖声明）----
$ohPkg = @{
  name = $moduleName
  version = "1.0.0"
  description = "XTS test module for $libraryName (scaffolded by AutoTest)"
  dependencies = @{}
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $moduleDir "oh-package.json5") -Value $ohPkg -Encoding UTF8

# ---- build-profile.json5（测试模块构建设置）----
$bp = @"
{
  "moduleType": "feature",
  "targets": [
    {
      "name": "default",
      "applyToProducts": ["default"]
    }
  ]
}
"@
Set-Content -LiteralPath (Join-Path $moduleDir "build-profile.json5") -Value $bp -Encoding UTF8

# ---- 测试入口（ArkTS 严格模式合规：无 any、显式类型、分号结尾）----
$entry = @"
import { describe, expect, it } from '@ohos/hypium';

/**
 * XTS 测试骨架（AutoTest scaffold，不含用例）。
 * 用例由用例流水线或人工补充；补完后跑 xts_run。
 */
export default function ${moduleName}Test(): void {
  describe('${libraryName}Xts', () => {
    it('scaffold_ready', 0, () => {
      expect(1).assertEqual(1);
    });
  });
}
"@
Set-Content -LiteralPath (Join-Path $moduleDir "src" "main" "ets" "test" "List.test.ets") -Value $entry -Encoding UTF8

# ---- 标记文件（幂等判据：没有它就认为结构不完整，会重新生成）----
$mark = @{
  libraryName = $libraryName
  bundleName = $bundleName
  moduleName = $moduleName
  scaffoldVersion = "1.0.0"
  note = "AutoTest XTS scaffold：只建骨架不建用例"
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $marker -Value $mark -Encoding UTF8

# ---- 产物校验 ----
if (-not (Test-Path -LiteralPath $moduleDir)) { & $script:Fail "[xts_scaffold] 模块目录未生成：$moduleDir" }
foreach ($f in @("oh-package.json5", "build-profile.json5", "src/main/ets/test/List.test.ets")) {
  $p = Join-Path $moduleDir $f
  if (-not (Test-Path -LiteralPath $p)) { & $script:Fail "[xts_scaffold] 骨架文件缺失：$f" }
}

Write-Output "[xts_scaffold] 完成：$moduleDir（骨架就绪，用例待补）"
Write-Output "TEST_MODULE_DIR=$moduleDir"
exit 0
