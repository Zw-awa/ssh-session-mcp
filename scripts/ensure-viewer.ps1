param(
  [Parameter(Mandatory = $true)]
  [string]$BindingKey,

  [int]$ViewerPort = 8765,

  [string]$ViewerHost = '127.0.0.1',

  [int]$IntervalMs = 1000,

  [string]$Title = 'SSH Session MCP Viewer',

  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Test-ViewerAlive {
  param(
    [int]$ProcessId
  )

  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Read-ViewerState {
  param(
    [string]$StatePath
  )

  if (-not (Test-Path -LiteralPath $StatePath)) {
    return @()
  }

  $raw = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @()
  }

  $parsed = $raw | ConvertFrom-Json -Depth 20
  if ($parsed -is [System.Array]) {
    return @($parsed)
  }

  return @($parsed)
}

function Write-ViewerState {
  param(
    [string]$StatePath,
    [object[]]$Records
  )

  $json = ConvertTo-Json -InputObject @($Records) -Depth 20
  Set-Content -LiteralPath $StatePath -Value $json -Encoding UTF8
}

$StatePath = Join-Path $RepoRoot '.viewer-processes.json'
$ViewerScript = Join-Path $RepoRoot 'build\viewer-cli.js'

if (-not (Test-Path -LiteralPath $ViewerScript)) {
  throw "viewer-cli.js not found: $ViewerScript"
}

$nodeCommand = Get-Command node -ErrorAction Stop
$nodePath = $nodeCommand.Source
$viewerUrl = "http://$ViewerHost`:$ViewerPort/binding/$([System.Uri]::EscapeDataString($BindingKey))"

$records = Read-ViewerState -StatePath $StatePath
$activeRecords = @()
$reused = $false
$existingPid = $null

foreach ($record in $records) {
  if ($null -eq $record) {
    continue
  }

  if ($record.bindingKey -eq $BindingKey) {
    $existingPid = [int]$record.pid
    if ($record.mode -eq 'terminal' -and $existingPid -gt 0 -and (Test-ViewerAlive -ProcessId $existingPid) -and $record.url -eq $viewerUrl) {
      $record.updatedAt = [DateTime]::UtcNow.ToString('o')
      $activeRecords += $record
      $reused = $true
      continue
    }

    if ($existingPid -gt 0 -and (Test-ViewerAlive -ProcessId $existingPid)) {
      Stop-Process -Id $existingPid -Force
    }

    continue
  }

  if ($record.pid -and (Test-ViewerAlive -ProcessId ([int]$record.pid))) {
    $activeRecords += $record
  }
}

if ($reused) {
  Write-ViewerState -StatePath $StatePath -Records $activeRecords
  [pscustomobject]@{
    bindingKey = $BindingKey
    pid = $existingPid
    launched = $false
    reusedExistingProcess = $true
    viewerUrl = $viewerUrl
    stateFile = $StatePath
  } | ConvertTo-Json -Depth 10
  exit 0
}

$escapedTitle = $Title.Replace("'", "''")
$escapedNodePath = $nodePath.Replace("'", "''")
$escapedViewerScript = $ViewerScript.Replace("'", "''")
$escapedBindingKey = $BindingKey.Replace("'", "''")
$escapedViewerHost = $ViewerHost.Replace("'", "''")

$innerCommand = @(
  "`$Host.UI.RawUI.WindowTitle = '$escapedTitle'",
  "& '$escapedNodePath' '$escapedViewerScript' '--binding=$escapedBindingKey' '--host=$escapedViewerHost' '--port=$ViewerPort' '--intervalMs=$IntervalMs'"
) -join '; '

$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoLogo',
  '-NoExit',
  '-Command',
  $innerCommand
) -PassThru

$record = [pscustomobject]@{
  bindingKey = $BindingKey
  pid = $proc.Id
  mode = 'terminal'
  sessionId = ''
  host = ''
  port = 0
  user = ''
  title = $Title
  url = $viewerUrl
  scope = 'connection'
  createdAt = [DateTime]::UtcNow.ToString('o')
  updatedAt = [DateTime]::UtcNow.ToString('o')
}

$activeRecords += $record
Write-ViewerState -StatePath $StatePath -Records $activeRecords

[pscustomobject]@{
  bindingKey = $BindingKey
  pid = $proc.Id
  launched = $true
  reusedExistingProcess = $false
  viewerUrl = $viewerUrl
  stateFile = $StatePath
} | ConvertTo-Json -Depth 10
