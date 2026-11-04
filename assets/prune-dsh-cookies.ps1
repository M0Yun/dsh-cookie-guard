<#
  Manual wrapper for the cookie guard. Works on the default DSH cookie
  database unless -CookiesPath is given.

  Example (preview without writing):
    powershell -File prune-dsh-cookies.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$CookiesPath = (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Network\Cookies'),
  [int]$WaitSeconds = 5,
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guard-lib.ps1')
$script:GuardQuiet = [bool]$Quiet

if (-not (Test-Path -LiteralPath $CookiesPath)) {
  Write-GuardLog "cookie database not found: $CookiesPath"
  exit 0
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (Test-CookiesLocked $CookiesPath) {
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 300
}

if (Test-CookiesLocked $CookiesPath) {
  Write-GuardLog 'DeepSeek Harness is running; cookie cleanup skipped.'
  exit 0
}

try {
  Write-GuardLog (Invoke-CookiePrune -Path $CookiesPath -DryRun:$DryRun)
}
catch {
  Write-GuardLog ("cleanup failed: " + $_.Exception.Message)
  exit 1
}
exit 0
