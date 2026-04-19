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

  [string]$SessionName = 'ssh-session-mcp-smoke',

  [int]$ViewerPort = 8794,

  [string]$ViewerHost = '127.0.0.1',

  [int]$ViewerRefreshMs = 1000,

  [int]$TimeoutSeconds = 30,

  [string]$StartupInput = 'hostname && whoami && pwd',

  [string]$StartupInputActor = 'codex',

  [string]$TestCommand = 'echo __MCP_SMOKE__ && hostname && whoami',

  [string]$TestActor = 'codex',

  [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Password) -and [string]::IsNullOrWhiteSpace($Key)) {
  throw 'Password or Key is required'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RunnerScript = Join-Path $PSScriptRoot 'demo-session-runner.mjs'
$LogDir = Join-Path $RepoRoot 'logs\live-viewer'
$StateFile = Join-Path $RepoRoot '.smoke-viewer-state.json'
$StdoutLog = Join-Path $LogDir 'smoke-shared-terminal.stdout.log'
$StderrLog = Join-Path $LogDir 'smoke-shared-terminal.stderr.log'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Remove-Item -LiteralPath $StateFile, $StdoutLog, $StderrLog -Force -ErrorAction SilentlyContinue

$BindingKey = "connection:$User@$($TargetHost):$Port"
$BindingRef = [System.Uri]::EscapeDataString($BindingKey)
$HealthUrl = "http://$ViewerHost`:$ViewerPort/health"
$AttachUrl = "http://$ViewerHost`:$ViewerPort/api/attach/binding/$BindingRef"
$InputUrl = "$AttachUrl/input"
$PageUrl = "http://$ViewerHost`:$ViewerPort/binding/$BindingRef"

$runnerArgs = @(
  $RunnerScript,
  "--host=$TargetHost",
  "--port=$Port",
  "--user=$User",
  "--viewerHost=$ViewerHost",
  "--viewerPort=$ViewerPort",
  "--viewerRefreshMs=$ViewerRefreshMs",
  "--sessionName=$SessionName",
  "--startupInput=$StartupInput",
  "--startupInputActor=$StartupInputActor",
  "--stateFile=$StateFile"
)

if (-not [string]::IsNullOrWhiteSpace($Password)) {
  $runnerArgs += "--password=$Password"
}

if (-not [string]::IsNullOrWhiteSpace($Key)) {
  $runnerArgs += "--key=$Key"
}

$proc = Start-Process -FilePath (Get-Command node -ErrorAction Stop).Source `
  -ArgumentList $runnerArgs `
  -WorkingDirectory $RepoRoot `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

function Wait-HttpReady {
  param(
    [int]$Seconds
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
      $stderr = if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Raw -Encoding UTF8 } else { '' }
      throw "runner exited early with code $($proc.ExitCode)`nstderr:`n$stderr"
    }

    try {
      $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
      if ($health.ok) {
        return $health
      }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }

  throw "runner did not become healthy within ${Seconds}s"
}

function Wait-SmokeOutput {
  param(
    [int]$Seconds,
    [object]$Baseline
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  $nextOffset = $Baseline.nextOutputOffset
  $nextSeq = $Baseline.nextEventSeq
  $combinedOutput = ''
  $combinedEvents = @()
  $script:LastSmokeOutput = ''

  while ((Get-Date) -lt $deadline) {
    $pollUrl = "${AttachUrl}?outputOffset=$nextOffset&eventSeq=$nextSeq&waitMs=1000&maxChars=16000&maxEvents=120"
    $poll = Invoke-RestMethod -Uri $pollUrl -TimeoutSec 5
    if ($poll.output) {
      $combinedOutput += [string]$poll.output
      $script:LastSmokeOutput = $combinedOutput
      if ($combinedOutput.Length -gt 64000) {
        $combinedOutput = $combinedOutput.Substring($combinedOutput.Length - 64000)
        $script:LastSmokeOutput = $combinedOutput
      }
    }

    if ($poll.events) {
      $combinedEvents += @($poll.events)
      if ($combinedEvents.Count -gt 200) {
        $combinedEvents = @($combinedEvents | Select-Object -Last 200)
      }
    }

    if ($combinedOutput -match "(`r?`n)$([Regex]::Escape($script:SmokeEndMarker))(`r?`n)") {
      return [pscustomobject]@{
        output = $combinedOutput
        events = @($combinedEvents)
      }
    }

    $nextOffset = $poll.nextOutputOffset
    $nextSeq = $poll.nextEventSeq
  }

  $excerpt = if ([string]::IsNullOrEmpty($script:LastSmokeOutput)) { '(no output captured after baseline)' } elseif ($script:LastSmokeOutput.Length -gt 3000) { $script:LastSmokeOutput.Substring($script:LastSmokeOutput.Length - 3000) } else { $script:LastSmokeOutput }
  throw "did not observe smoke marker in attach output`nlast output excerpt:`n$excerpt"
}

try {
  $script:SmokeStartMarker = "__MCP_SMOKE_BEGIN_$([Guid]::NewGuid().ToString('N'))__"
  $script:SmokeEndMarker = "__MCP_SMOKE_END_$([Guid]::NewGuid().ToString('N'))__"
  $wrappedCommand = "printf '%s\n' '$script:SmokeStartMarker' && $TestCommand && printf '%s\n' '$script:SmokeEndMarker'"
  $health = Wait-HttpReady -Seconds $TimeoutSeconds
  $baseline = Invoke-RestMethod -Uri $AttachUrl -TimeoutSec 5
  $payload = @{
    data = "$wrappedCommand`r"
    records = @(
      @{
        actor = $TestActor
        type = 'input'
        text = $wrappedCommand
      }
    )
  } | ConvertTo-Json -Depth 10

  Invoke-RestMethod -Method Post -Uri $InputUrl -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 5 | Out-Null
  $smoke = Wait-SmokeOutput -Seconds $TimeoutSeconds -Baseline $baseline
  $page = Invoke-WebRequest -UseBasicParsing -Uri $PageUrl -TimeoutSec 5

  [pscustomobject]@{
    ok = $true
    runnerPid = $proc.Id
    health = $health
    bindingKey = $baseline.binding.bindingKey
    sessionId = $baseline.summary.sessionId
    browserAttachInteractive = ($page.Content -match 'Browser attach beta')
    smokeStartMarker = $script:SmokeStartMarker
    smokeEndMarker = $script:SmokeEndMarker
    wrappedCommand = $wrappedCommand
    smokeOutputExcerpt = (($smoke.output -split "`n") | Select-Object -First 12) -join "`n"
    latestEvents = @($smoke.events | Select-Object -Last 5)
    stdoutLog = $StdoutLog
    stderrLog = $StderrLog
  } | ConvertTo-Json -Depth 20
} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }

  if (-not $KeepArtifacts) {
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  }
}
