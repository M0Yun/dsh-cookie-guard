# Shared helpers for the DSH cookie guard. Dot-source this file; it exits nothing.

$script:GuardRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath $script:GuardRoot)) { $script:GuardRoot = $PSScriptRoot }
$script:GuardLog = Join-Path $script:GuardRoot 'guard.log'

function Write-GuardLog([string]$Text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
  try { Add-Content -LiteralPath $script:GuardLog -Value $line -Encoding UTF8 } catch { }
  if (-not $script:GuardQuiet) { Write-Host $Text }
}

<#
  True while DeepSeek Harness holds its cookie database. Chromium opens the
  file without sharing, so a share-none open is a reliable "is it running".
#>
function Test-CookiesLocked([string]$Path) {
  try {
    $handle = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None)
    $handle.Close()
    return $false
  }
  catch {
    return $true
  }
}

<#
  Delete stale "dsh-auth-*" cookies from an unlocked cookie database.
  Returns a one-line summary.
#>
function Invoke-CookiePrune {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$DryRun
  )

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($null -eq $python) { throw 'python not found on PATH' }

  $helper = Join-Path $script:GuardRoot 'prune_cookies.py'
  if (-not (Test-Path -LiteralPath $helper)) { throw "helper missing: $helper" }

  if (-not $DryRun) {
    $backupDir = Join-Path $script:GuardRoot 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $target = Join-Path $backupDir ('Cookies-{0}.bak' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $Path -Destination $target -Force
    Get-ChildItem -LiteralPath $backupDir -Filter 'Cookies-*.bak' |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 10 |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }

  $pyArgs = @($helper, $Path)
  if ($DryRun) { $pyArgs += '--dry-run' }

  $output = & $python.Source @pyArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw ("prune failed: " + ($output -join ' | ')) }
  return ($output -join ' ')
}
