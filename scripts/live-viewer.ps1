<#
.SYNOPSIS
启动、查询或关闭当前仓库版 SSH Session MCP 的本地演示 viewer。

.DESCRIPTION
这个脚本会在后台启动一个本地 runner。runner 会拉起当前仓库的 ssh-session-mcp，
建立一条持久 SSH 会话，并通过 ensure-viewer.ps1 打开或复用一个外部 viewer 终端。

默认用途是：
1. 后台常驻保持 SSH 会话
2. 外部终端显示左侧远端回显、右侧输入事件
3. 同一连接只保留一个 viewer 终端

.PARAMETER Action
可选值：start、status、stop。

.PARAMETER Host
SSH 主机地址。

.PARAMETER Port
SSH 端口，默认 22。

.PARAMETER User
SSH 用户名。

.PARAMETER Password
SSH 密码。

.PARAMETER Key
SSH 私钥路径。未提供 Password 时使用。

.PARAMETER SessionName
会话名，默认 ssh-session-mcp-demo。

.PARAMETER ViewerPort
本地 viewer HTTP 服务端口，默认 8793。

.PARAMETER ViewerHost
本地 viewer HTTP 服务绑定地址，默认 127.0.0.1。

.PARAMETER ViewerRefreshMs
viewer 刷新间隔，默认 1000ms。

.PARAMETER StartupInput
建立 SSH 会话后立即发送的命令，默认 "hostname && whoami && pwd"。

.PARAMETER StartupInputActor
StartupInput 在右栏中的 actor 标签，默认 codex。

.PARAMETER Title
外部 viewer 终端标题。

.PARAMETER StatePath
runner 状态文件路径。

.PARAMETER Help
显示帮助。

.EXAMPLE
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-viewer.ps1 `
  -Action start -Host $env:SSH_HOST -User $env:SSH_USER -Password $env:SSH_PASSWORD

.EXAMPLE
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-viewer.ps1 -Action status

.EXAMPLE
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-viewer.ps1 -Action stop
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('start', 'status', 'stop')]
  [string]$Action = 'status',

  [Alias('Host')]
  [string]$TargetHost,

  [int]$Port = 22,

  [string]$User,

  [string]$Password,

  [string]$Key,

  [string]$SessionName = 'ssh-session-mcp-demo',

  [int]$ViewerPort = 8793,

  [string]$ViewerHost = '127.0.0.1',

  [int]$ViewerRefreshMs = 1000,

  [string]$StartupInput = 'hostname && whoami && pwd',

  [string]$StartupInputActor = 'codex',

  [string]$Title,

  [string]$StatePath = (Join-Path (Split-Path -Parent $PSScriptRoot) '.demo-viewer-state.json'),

  [switch]$SkipViewerAutoOpen,

  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help -Full $PSCommandPath
  exit 0
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RunnerScript = Join-Path $PSScriptRoot 'demo-session-runner.mjs'
$EnsureViewerScript = Join-Path $PSScriptRoot 'ensure-viewer.ps1'
$ViewerStatePath = Join-Path $RepoRoot '.viewer-processes.json'
$LogDir = Join-Path $RepoRoot 'logs\live-viewer'
$StdoutLog = Join-Path $LogDir 'runner.stdout.log'
$StderrLog = Join-Path $LogDir 'runner.stderr.log'
$PwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$ShellPath = if ($PwshCommand) { $PwshCommand.Source } else { 'powershell.exe' }

function Test-ProcessAlive {
  param(
    [Nullable[int]]$ProcessId
  )

  if ($null -eq $ProcessId -or $ProcessId -le 0) {
    return $false
  }

  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Read-JsonFile {
  param(
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }

  return ($raw | ConvertFrom-Json -Depth 20)
}

function Remove-IfExists {
  param(
    [string]$Path
  )

  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Get-RunnerHealth {
  param(
    [string]$ViewerHostValue,
    [int]$ViewerPortValue
  )

  $healthUrl = "http://$ViewerHostValue`:$ViewerPortValue/health"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return [pscustomobject]@{
      ok = ($response.StatusCode -eq 200)
      statusCode = $response.StatusCode
      healthUrl = $healthUrl
      error = $null
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      statusCode = $null
      healthUrl = $healthUrl
      error = $_.Exception.Message
    }
  }
}

function Wait-RunnerReady {
  param(
    [int]$TimeoutSeconds,
    [string]$StateFilePath,
    [string]$ViewerHostValue,
    [int]$ViewerPortValue,
    [Nullable[int]]$RunnerProcessId,
    [string]$StdoutLogPath,
    [string]$StderrLogPath
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $state = Read-JsonFile -Path $StateFilePath
    $health = Get-RunnerHealth -ViewerHostValue $ViewerHostValue -ViewerPortValue $ViewerPortValue
    if ($state -and $state.status -eq 'running' -and $health.ok) {
      return [pscustomobject]@{
        state = $state
        health = $health
      }
    }

    if ($RunnerProcessId -and (-not (Test-ProcessAlive -ProcessId $RunnerProcessId))) {
      $stdoutTail = if (Test-Path -LiteralPath $StdoutLogPath) { (Get-Content -LiteralPath $StdoutLogPath -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } else { '' }
      $stderrTail = if (Test-Path -LiteralPath $StderrLogPath) { (Get-Content -LiteralPath $StderrLogPath -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } else { '' }
      throw "Runner exited before becoming ready.`nstdout:`n$stdoutTail`n`nstderr:`n$stderrTail"
    }

    Start-Sleep -Milliseconds 400
  }

  throw "Runner did not become ready within ${TimeoutSeconds}s"
}

function Stop-ViewerByBinding {
  param(
    [string]$BindingKey
  )

  if ([string]::IsNullOrWhiteSpace($BindingKey)) {
    return $null
  }

  $viewerState = Read-JsonFile -Path $ViewerStatePath
  if ($null -eq $viewerState) {
    return $null
  }

  $records = @()
  if ($viewerState -is [System.Array]) {
    $records = @($viewerState)
  } else {
    $records = @($viewerState)
  }

  foreach ($record in $records) {
    if ($null -eq $record) {
      continue
    }

    if ($record.bindingKey -eq $BindingKey -and $record.pid) {
      $viewerProcessId = [int]$record.pid
      if (Test-ProcessAlive -ProcessId $viewerProcessId) {
        Stop-Process -Id $viewerProcessId -Force
        return [pscustomobject]@{
          pid = $viewerProcessId
          bindingKey = $BindingKey
          stopped = $true
        }
      }
    }
  }

  return $null
}

function Get-StatusPayload {
  $state = Read-JsonFile -Path $StatePath
  $runnerPid = if ($state) { [int]($state.runnerPid) } else { $null }
  $health = if ($state) {
    Get-RunnerHealth -ViewerHostValue $state.viewerHost -ViewerPortValue $state.viewerPort
  } else {
    Get-RunnerHealth -ViewerHostValue $ViewerHost -ViewerPortValue $ViewerPort
  }
  $viewerInfo = $null

  if ($state -and $state.viewerBindingKey) {
    $viewerState = Read-JsonFile -Path $ViewerStatePath
    $records = @()
    if ($viewerState -is [System.Array]) {
      $records = @($viewerState)
    } elseif ($viewerState) {
      $records = @($viewerState)
    }

    foreach ($record in $records) {
      if ($record.bindingKey -eq $state.viewerBindingKey) {
        $viewerInfo = [pscustomobject]@{
          pid = [int]$record.pid
          title = $record.title
          url = $record.url
          alive = (Test-ProcessAlive -ProcessId ([int]$record.pid))
        }
        break
      }
    }
  }

  return [pscustomobject]@{
    statePath = $StatePath
    state = $state
    runnerAlive = (Test-ProcessAlive -ProcessId $runnerPid)
    health = $health
    viewer = $viewerInfo
    stdoutLog = $StdoutLog
    stderrLog = $StderrLog
  }
}

if ($Action -eq 'status') {
  Get-StatusPayload | ConvertTo-Json -Depth 20
  exit 0
}

if ($Action -eq 'stop') {
  $status = Get-StatusPayload
  if (-not $status.state) {
    [pscustomobject]@{
      stopped = $false
      message = 'No runner state file found'
      statePath = $StatePath
    } | ConvertTo-Json -Depth 20
    exit 0
  }

  if ($PSCmdlet.ShouldProcess("runner $($status.state.runnerPid)", 'Stop live viewer runner')) {
    $viewerStop = Stop-ViewerByBinding -BindingKey $status.state.viewerBindingKey

    if ($status.runnerAlive) {
      Stop-Process -Id ([int]$status.state.runnerPid) -Force
    }

    Remove-IfExists -Path $StatePath

    [pscustomobject]@{
      stopped = $true
      runnerPid = [int]$status.state.runnerPid
      viewer = $viewerStop
      statePath = $StatePath
    } | ConvertTo-Json -Depth 20
    exit 0
  }

  exit 0
}

if ([string]::IsNullOrWhiteSpace($TargetHost)) {
  throw 'Host is required for -Action start'
}

if ([string]::IsNullOrWhiteSpace($User)) {
  throw 'User is required for -Action start'
}

if ([string]::IsNullOrWhiteSpace($Password) -and [string]::IsNullOrWhiteSpace($Key)) {
  throw 'Password or Key is required for -Action start'
}

if (-not (Test-Path -LiteralPath $RunnerScript)) {
  throw "Runner script not found: $RunnerScript"
}

if (-not (Test-Path -LiteralPath $EnsureViewerScript)) {
  throw "ensure-viewer script not found: $EnsureViewerScript"
}

$existingStatus = Get-StatusPayload
if ($existingStatus.state -and $existingStatus.runnerAlive -and $existingStatus.health.ok) {
  $resolvedTitle = if ([string]::IsNullOrWhiteSpace($Title)) {
    "SSH Session MCP Viewer - $($existingStatus.state.user)@$($existingStatus.state.host):$($existingStatus.state.port)"
  } else {
    $Title
  }

  $viewerPayload = $null
  if (-not $SkipViewerAutoOpen) {
    $viewerResultJson = & $ShellPath -NoLogo -NoProfile -ExecutionPolicy Bypass -File $EnsureViewerScript `
      -BindingKey $existingStatus.state.viewerBindingKey `
      -ViewerPort ([int]$existingStatus.state.viewerPort) `
      -ViewerHost $existingStatus.state.viewerHost `
      -IntervalMs ([int]$existingStatus.state.viewerRefreshMs) `
      -Title $resolvedTitle `
      -RepoRoot $RepoRoot
    $viewerPayload = $viewerResultJson | ConvertFrom-Json -Depth 20
  }

  [pscustomobject]@{
    reusedRunner = $true
    state = $existingStatus.state
    health = $existingStatus.health
    viewer = $viewerPayload
    stdoutLog = $StdoutLog
    stderrLog = $StderrLog
  } | ConvertTo-Json -Depth 20
  exit 0
}

if ($existingStatus.runnerAlive) {
  Stop-Process -Id ([int]$existingStatus.state.runnerPid) -Force
}

Remove-IfExists -Path $StatePath
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Remove-IfExists -Path $StdoutLog
Remove-IfExists -Path $StderrLog

$nodePath = (Get-Command node -ErrorAction Stop).Source
$resolvedTitle = if ([string]::IsNullOrWhiteSpace($Title)) {
  "SSH Session MCP Viewer - $User@$($TargetHost):$Port"
} else {
  $Title
}

$startupInputBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($StartupInput))

$runnerArgs = @(
  $RunnerScript,
  "--host=$TargetHost",
  "--port=$Port",
  "--user=$User",
  "--viewerHost=$ViewerHost",
  "--viewerPort=$ViewerPort",
  "--viewerRefreshMs=$ViewerRefreshMs",
  "--sessionName=$SessionName",
  "--startupInputBase64=$startupInputBase64",
  "--startupInputActor=$StartupInputActor",
  "--stateFile=$StatePath"
)

if (-not [string]::IsNullOrWhiteSpace($Password)) {
  $runnerArgs += "--password=$Password"
}

if (-not [string]::IsNullOrWhiteSpace($Key)) {
  $runnerArgs += "--key=$Key"
}

if ($PSCmdlet.ShouldProcess("$User@$($TargetHost):$Port", 'Start live viewer runner')) {
  $runnerProcess = Start-Process -FilePath $nodePath `
    -ArgumentList $runnerArgs `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -WindowStyle Hidden `
    -PassThru

  $ready = Wait-RunnerReady -TimeoutSeconds 20 -StateFilePath $StatePath -ViewerHostValue $ViewerHost -ViewerPortValue $ViewerPort -RunnerProcessId $runnerProcess.Id -StdoutLogPath $StdoutLog -StderrLogPath $StderrLog

  $viewerPayload = $null
  if (-not $SkipViewerAutoOpen) {
    $viewerResultJson = & $ShellPath -NoLogo -NoProfile -ExecutionPolicy Bypass -File $EnsureViewerScript `
      -BindingKey $ready.state.viewerBindingKey `
      -ViewerPort $ViewerPort `
      -ViewerHost $ViewerHost `
      -IntervalMs $ViewerRefreshMs `
      -Title $resolvedTitle `
      -RepoRoot $RepoRoot
    $viewerPayload = $viewerResultJson | ConvertFrom-Json -Depth 20
  }

  [pscustomobject]@{
    reusedRunner = $false
    runnerPid = $runnerProcess.Id
    state = $ready.state
    health = $ready.health
    viewer = $viewerPayload
    stdoutLog = $StdoutLog
    stderrLog = $StderrLog
  } | ConvertTo-Json -Depth 20
  exit 0
}
