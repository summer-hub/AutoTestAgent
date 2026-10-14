# 起本地 mock HTTP server（envkit 脚本资产：mock_server_up）
#
# 契约见 src/services/envkit/builtin.ts::mock_server_up。
# 网络类三方库的测试不能依赖真实第三方服务——对方限流/改接口/挂掉都会让测试突然全失败，
# 且结果不可复现。本地 mock server + fixture 目录是唯一可控的路。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# ⚠️ 生命周期说明（与普通步骤不同）：
#   本步骤**不前台常驻**——那样会一直占着 runner 直到超时。它以后台进程方式起服务，
#   写出 SERVER_URL 与 SERVER_PID_PATH 后立即退出 0；后续用例执行期间服务保持存活。
#   停止服务请用配套的 mock_server_stop（按 pid 文件结束进程）。
#
# 纪律：
#   · 幂等性为 false（同一端口起两个会冲突）——契约里已如实标注；
#   · 端口占用要明确报错，不能静默换端口（测试代码写死了基址）；
#   · fixture 目录为空是失败，不是"起一个空服务"——那会让所有请求 404，测试结果无意义。
param(
  [Parameter(Mandatory=$true)][string]$fixtureDir,
  [int]$port = 18080,
  [int]$latencyMs = 0
)

$ErrorActionPreference = "Stop"
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $fixtureDir)) {
  & $script:Fail "[mock_server_up] fixture 目录不存在：$fixtureDir"
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  & $script:Missing "[mock_server_up] 未检测到 node 命令（mock server 由 Node 实现）。"
}
if ($port -lt 1024 -or $port -gt 65535) { & $script:Fail "[mock_server_up] 端口非法：$port" }

# fixture 非空校验：空目录起服务等于所有请求 404，测试结果无意义
$fixtures = @(Get-ChildItem -LiteralPath $fixtureDir -Filter *.json -File -ErrorAction SilentlyContinue)
if ($fixtures.Count -eq 0) {
  & $script:Fail "[mock_server_up] fixture 目录里没有 .json：$fixtureDir（每个 .json 对应一个路由响应）"
}

# 端口占用检查：不能静默换端口（测试代码写死了基址）
$inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  & $script:Fail "[mock_server_up] 端口已被占用：$port。请先停止占用进程或换端口。"
}

$runDir = Join-Path $fixtureDir ".mock-run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$logPath = Join-Path $runDir "mock-server.log"
$pidPath = Join-Path $runDir "mock-server.pid"

# 服务实现（Node，随脚本内联）：读 fixture 目录，按文件名匹配路由，
# 统一注入 latencyMs；未匹配返回 404 JSON（明确而非静默）。
$serverJs = @'
const http = require('http');
const fs = require('fs');
const path = require('path');
const fixtureDir = process.argv[2];
const port = Number(process.argv[3]);
const latency = Number(process.argv[4] || 0);
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  };
  const respond = () => {
    const name = (req.url || '/').replace(/^\/+/, '').split('?')[0] || 'index';
    const file = path.join(fixtureDir, name.endsWith('.json') ? name : `${name}.json`);
    if (!fs.existsSync(file)) { send(404, { error: 'no_fixture', url: req.url }); return; }
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { send(500, { error: 'bad_fixture', detail: String(e.message) }); return; }
    const code = typeof obj.status === 'number' ? obj.status : 200;
    const payload = obj.body !== undefined ? obj.body : obj;
    send(code, payload);
  };
  if (latency > 0) { setTimeout(respond, latency); } else { respond(); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK_LISTENING port=${port}`);
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
'@
$serverFile = Join-Path $runDir "mock-server.js"
Set-Content -LiteralPath $serverFile -Value $serverJs -Encoding UTF8

Write-Output "[mock_server_up] fixture=$fixtureDir port=$port latency=${latencyMs}ms fixtures=$($fixtures.Count)"

# 后台启动（不占住 runner），写 pid 文件供 mock_server_stop 使用
$p = Start-Process -FilePath "node" -ArgumentList @($serverFile, $fixtureDir, "$port", "$latencyMs") `
  -WorkingDirectory $runDir -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" `
  -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidPath -Value "$($p.Id)" -Encoding ASCII

# 就绪探测：等 MOCK_LISTENING 出现在日志里（最多 10 秒）
$ready = $false
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 200
  if ($p.HasExited) {
    & $script:Fail "[mock_server_up] 服务进程提前退出（code=$($p.ExitCode)），日志：$(if (Test-Path $logPath) { Get-Content $logPath -Raw } else '(无)')"
  }
  if ((Test-Path -LiteralPath $logPath) -and ((Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue) -match 'MOCK_LISTENING')) {
    $ready = $true; break
  }
}
if (-not $ready) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
  & $script:Fail "[mock_server_up] 服务 10 秒内未就绪：port=$port（看 $logPath）"
}

Write-Output "[mock_server_up] 服务就绪：http://127.0.0.1:$port（pid=$($p.Id)）"
Write-Output "SERVER_URL=http://127.0.0.1:$port"
Write-Output "SERVER_PID_PATH=$pidPath"
Write-Output "SERVER_LOG_PATH=$logPath"
exit 0
