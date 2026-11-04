param(
  [int]$WaitSeconds = 3,
  [string]$CookieDb = (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Network\Cookies'),
  [string]$AppExe = '',
  [switch]$IgnoreRunning
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guard-lib.ps1')
$script:GuardQuiet = $true

$exe = $AppExe
$appPathFile = Join-Path $PSScriptRoot 'app-path.txt'
if (Test-Path -LiteralPath $appPathFile) {
  $exe = (Get-Content -LiteralPath $appPathFile -Raw).Trim()
}
if ($exe -eq '' -or -not (Test-Path -LiteralPath $exe)) {
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
}
if (-not (Test-Path -LiteralPath $exe)) {
  Write-GuardLog "app not found: $exe"
  exit 1
}

$db = $CookieDb

# Already up: bring the existing window forward instead of a second instance.
if (-not $IgnoreRunning -and $null -ne (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  try { (New-Object -ComObject WScript.Shell).AppActivate('DeepSeek Harness') | Out-Null } catch { }
  Write-GuardLog 'already running; focused the existing window'
  exit 0
}

# Give a just-quit instance a moment to release the database.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (Test-CookiesLocked $db) {
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 300
}

if (Test-CookiesLocked $db) {
  Write-GuardLog 'cookie database still locked; starting without cleanup'
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
  exit 0
}

try {
  Write-GuardLog (Invoke-CookiePrune -Path $db)
}
catch {
  Write-GuardLog ("cleanup skipped: " + $_.Exception.Message)
}

Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
