<#
.SYNOPSIS
打开一个可交互的共享 SSH 终端窗口，并确保后台 runner 已存在。

.DESCRIPTION
这个脚本设计给外部 PowerShell 终端直接执行：
1. 先调用 live-viewer.ps1 确保后台 runner 存在
2. 不额外再弹第二个 viewer
3. 直接在当前终端里运行 build/viewer-cli.js 并附着到同一个 SSH 会话

.EXAMPLE
powershell -NoLogo -NoExit -ExecutionPolicy Bypass -File .\scripts\open-viewer-window.ps1 `
  -Host $env:SSH_HOST -User $env:SSH_USER -Password $env:SSH_PASSWORD
#>
[CmdletBinding()]
param(
  [Alias('Host')]
  [Parameter(Mandatory = $true)]
  [string]$TargetHost,

  [int]$Port = 22,

  [Parameter(Mandatory = $true)]
  [string]$User,

  [string]$Password,

  [string]$Key,

  [string]$SessionName = 'ssh-session-mcp-demo',

  [int]$ViewerPort = 8793,

  [string]$ViewerHost = '127.0.0.1',

  [int]$ViewerRefreshMs = 1000,

  [string]$StartupInput = 'hostname && whoami && pwd',

  [string]$StartupInputActor = 'codex',

  [string]$Title
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LiveViewerScript = Join-Path $PSScriptRoot 'live-viewer.ps1'
$ViewerScript = Join-Path $RepoRoot 'build\viewer-cli.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$PwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$ShellPath = if ($PwshCommand) { $PwshCommand.Source } else { 'powershell.exe' }
$LogDir = Join-Path $RepoRoot 'logs\live-viewer'
$TraceLog = Join-Path $LogDir 'open-viewer-window.log'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-Trace {
  param(
    [string]$Message
  )

  $line = "[{0}] {1}" -f ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff')), $Message
  Add-Content -LiteralPath $TraceLog -Value $line -Encoding UTF8
}

Write-Trace "open-viewer-window start target=$User@$($TargetHost):$Port"
Set-Location -LiteralPath $RepoRoot

if (-not (Test-Path -LiteralPath $ViewerScript)) {
  throw "viewer-cli.js not found: $ViewerScript"
}

$resolvedTitle = if ([string]::IsNullOrWhiteSpace($Title)) {
  "SSH Session MCP Viewer - $User@$($TargetHost):$Port"
} else {
  $Title
}

$Host.UI.RawUI.WindowTitle = $resolvedTitle

try {
  Write-Host "starting runner for $User@$($TargetHost):$Port ..."
  Write-Host "mode: interactive attach terminal"
  Write-Host "detach: Ctrl+]"
  Write-Host ''
  Write-Trace 'calling live-viewer start'
  $startJson = & $ShellPath -NoLogo -NoProfile -ExecutionPolicy Bypass -File $LiveViewerScript `
    -Action start `
    -Host $TargetHost `
    -Port $Port `
    -User $User `
    -Password $Password `
    -Key $Key `
    -SessionName $SessionName `
    -ViewerPort $ViewerPort `
    -ViewerHost $ViewerHost `
    -ViewerRefreshMs $ViewerRefreshMs `
    -StartupInput $StartupInput `
    -StartupInputActor $StartupInputActor `
    -Title $resolvedTitle `
    -SkipViewerAutoOpen

  Write-Trace "live-viewer returned payload length=$($startJson.Length)"
  $startResult = $startJson | ConvertFrom-Json -Depth 20

  if (-not $startResult.health.ok) {
    throw "runner is not healthy: $($startResult.health | ConvertTo-Json -Depth 20 -Compress)"
  }

  if (-not $startResult.state.viewerBindingKey) {
    throw 'viewerBindingKey missing from runner state'
  }

  Write-Trace "runner ready binding=$($startResult.state.viewerBindingKey) pid=$($startResult.state.runnerPid)"
  Write-Host "viewerBindingKey: $($startResult.state.viewerBindingKey)"
  Write-Host "viewerUrl: $($startResult.state.viewerBindingUrl)"
  Write-Host "runnerPid: $($startResult.state.runnerPid)"
  Write-Host 'viewerMode: interactive-attach'
  Write-Host 'detach: Ctrl+]'
  Write-Host ''
  Write-Host 'starting viewer ...'
  Write-Host ''
  Write-Trace 'starting viewer-cli in current terminal'

  & $nodePath $ViewerScript `
    "--binding=$($startResult.state.viewerBindingKey)" `
    "--host=$ViewerHost" `
    "--port=$ViewerPort" `
    "--intervalMs=$ViewerRefreshMs" `
    '--exitOnUnavailableMs=1500' `
    '--exitOnClosed=true' `
    '--helpFooter=true'
} catch {
  Write-Trace "fatal: $($_.Exception.Message)"
  throw
}
