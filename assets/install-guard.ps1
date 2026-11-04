<#
  Point the DeepSeek Harness shortcuts at launch-dsh.vbs so every start runs
  the cookie cleanup first.
#>
[CmdletBinding()]
param(
  [string]$AppExe = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
)

$ErrorActionPreference = 'Stop'
$guardDir = $PSScriptRoot
$vbs = Join-Path $guardDir 'launch-dsh.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path -LiteralPath $vbs)) { throw "launcher missing: $vbs" }
if (-not (Test-Path -LiteralPath $AppExe)) { throw "app not found: $AppExe" }

Set-Content -LiteralPath (Join-Path $guardDir 'app-path.txt') -Value $AppExe -Encoding ASCII

$shortcuts = @(
  (Join-Path $env:USERPROFILE 'Desktop\DeepSeek Harness.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk')
)

$shell = New-Object -ComObject WScript.Shell
foreach ($path in $shortcuts) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $wscript
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = Split-Path -Parent $AppExe
  $lnk.IconLocation = "$AppExe,0"
  $lnk.Description = 'DeepSeek Harness (cleans stale login cookies first)'
  $lnk.Save()
  Write-Host "updated: $path"
}

Write-Host "launcher: $vbs"
