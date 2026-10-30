# 用途：在 Windows 上验证 CC Switch 的「镜像直下安装」是否可用（不依赖 Node、不访问 claude.ai / chatgpt.com）
#       会分别装 Claude Code 与 Codex，装完各自 --version 自检，并打印装到哪、用的什么版本。
# 用法：右键「使用 PowerShell 运行」；
#       或打开 PowerShell 执行：  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-cli-windows.ps1
#       只验 Claude：  ... -File .\install-cli-windows.ps1 -Only claude
#       只验 Codex：   ... -File .\install-cli-windows.ps1 -Only codex
# 入参：-Only claude|codex|both（默认 both）
# 出参：每步的 OK/FAIL 行；退出码 0 全部成功、1 有失败
# 依赖：Windows 10 1803+ / Server 2019+（自带 tar.exe）、PowerShell 5.1+
# 说明：装到 %LOCALAPPDATA%，per-user，不弹 UAC；卸载 = 删掉打印出来的那两个目录
# 关键词：windows, claude code, codex, 镜像, npmmirror, 安装, install, 一键, 验证, tar, powershell,
#         junction, codex_home, standalone, 无 node, 免 node, 分发, 小白
# 更新：2026-10-25

param(
  [ValidateSet('both', 'claude', 'codex')]
  [string]$Only = 'both'
)

$ErrorActionPreference = 'Stop'
$Mirror = 'https://registry.npmmirror.com'
$failures = @()

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Bad($msg)  { Write-Host "  FAIL $msg" -ForegroundColor Red }

function Get-Arch {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
  return 'x64'
}

function Add-UserPath($dir) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if ($userPath -notlike "*$dir*") {
    $joined = ($userPath.TrimEnd(';') + ';' + $dir).TrimStart(';')
    [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
  }
  if ($env:Path -notlike "*$dir*") { $env:Path = $env:Path + ';' + $dir }
}

function Install-Claude {
  Write-Step 'Claude Code（镜像直下）'
  $arch = Get-Arch
  $ver = (Invoke-RestMethod -Uri "$Mirror/@anthropic-ai/claude-code/latest" -UseBasicParsing -TimeoutSec 30).version
  if (-not $ver) { throw '取不到版本号' }
  Write-Host "  版本 $ver / 平台 win32-$arch"

  $tmp = Join-Path $env:TEMP ('claude-mirror-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $tgz = Join-Path $tmp 'p.tgz'
    $url = "$Mirror/@anthropic-ai/claude-code-win32-$arch/-/claude-code-win32-$arch-$ver.tgz"
    Write-Host "  下载 $url"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing -TimeoutSec 900
    $sw.Stop()
    Write-Host ("  下载完成 {0:N1} MB / {1:N1}s" -f ((Get-Item $tgz).Length / 1MB), $sw.Elapsed.TotalSeconds)

    tar.exe -xzf $tgz -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "tar 解压失败 ($LASTEXITCODE)" }

    $exe = Get-ChildItem -Path (Join-Path $tmp 'package') -Filter 'claude.exe' -Recurse -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if (-not $exe) { throw '压缩包里没找到 claude.exe' }

    $dest = Join-Path $env:LOCALAPPDATA 'Programs\claude\bin'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item $exe.FullName (Join-Path $dest 'claude.exe') -Force
    Add-UserPath $dest
    Write-Ok "已装到 $dest\claude.exe"
    $v = & (Join-Path $dest 'claude.exe') --version 2>&1
    Write-Ok "claude --version → $v"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-Codex {
  Write-Step 'Codex（镜像直下，模仿官方 standalone 布局）'
  $arch = Get-Arch
  $triple = if ($arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
  $ver = (Invoke-RestMethod -Uri "$Mirror/@openai/codex/latest" -UseBasicParsing -TimeoutSec 30).version
  if (-not $ver) { throw '取不到版本号' }
  Write-Host "  版本 $ver / 平台 win32-$arch / triple $triple"

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  $dest = Join-Path $codexHome "packages\standalone\releases\$ver-$triple"
  $current = Join-Path $codexHome 'packages\standalone\current'

  $tmp = Join-Path $env:TEMP ('codex-mirror-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $tgz = Join-Path $tmp 'p.tgz'
    $url = "$Mirror/@openai/codex/-/codex-$ver-win32-$arch.tgz"
    Write-Host "  下载 $url"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing -TimeoutSec 900
    $sw.Stop()
    Write-Host ("  下载完成 {0:N1} MB / {1:N1}s" -f ((Get-Item $tgz).Length / 1MB), $sw.Elapsed.TotalSeconds)

    tar.exe -xzf $tgz -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "tar 解压失败 ($LASTEXITCODE)" }

    $vendor = Get-ChildItem -Path (Join-Path $tmp 'package\vendor') -Directory -ErrorAction SilentlyContinue |
              Select-Object -First 1
    if (-not $vendor) { throw '压缩包里没找到 vendor 目录' }
    Write-Host "  实际 triple 目录：$($vendor.Name)"

    New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item $vendor.FullName $dest

    # current 是指向当前版本的链接。junction 不需要管理员权限，比 symlink 稳妥。
    if (Test-Path $current) { Remove-Item $current -Force -Recurse }
    New-Item -ItemType Junction -Path $current -Target $dest | Out-Null
    Write-Ok "current → $dest"

    # 入口目录本身做成 junction（不是建软链或 .cmd 转发）——这样 real path 里会带
    # \packages\standalone\，上游 codex_standalone_install() 才认得这是官方式独立安装。
    # junction 不需要开发者模式/管理员。
    $binDir = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin'
    if (Test-Path $binDir) { Remove-Item $binDir -Force -Recurse }
    New-Item -ItemType Directory -Path (Split-Path $binDir -Parent) -Force | Out-Null
    New-Item -ItemType Junction -Path $binDir -Target (Join-Path $dest 'bin') | Out-Null
    Add-UserPath $binDir
    Write-Ok "入口目录（junction） $binDir"

    $v = & (Join-Path $dest 'bin\codex.exe') --version 2>&1
    Write-Ok "codex --version → $v"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "CC Switch - Windows 镜像安装验证脚本" -ForegroundColor Yellow
Write-Host "PowerShell $($PSVersionTable.PSVersion) / $([System.Environment]::OSVersion.VersionString) / $env:PROCESSOR_ARCHITECTURE"
$tarOk = (Get-Command tar.exe -ErrorAction SilentlyContinue) -ne $null
if (-not $tarOk) {
  Write-Bad '本机没有 tar.exe（需要 Windows 10 1803+ / Server 2019+）'
  exit 1
}
Write-Ok "tar.exe 可用：$((Get-Command tar.exe).Source)"

if ($Only -in @('both', 'claude')) {
  try { Install-Claude } catch { Write-Bad "Claude: $($_.Exception.Message)"; $failures += 'claude' }
}
if ($Only -in @('both', 'codex')) {
  try { Install-Codex } catch { Write-Bad "Codex: $($_.Exception.Message)"; $failures += 'codex' }
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host '全部成功。新开一个终端窗口，输入 claude 或 codex 即可使用。' -ForegroundColor Green
  exit 0
} else {
  Write-Host ("有失败项：" + ($failures -join ', ')) -ForegroundColor Red
  exit 1
}
