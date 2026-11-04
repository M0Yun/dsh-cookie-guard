# 用 GitHub Desktop 已登录的凭据（Windows 凭据管理器里的 OAuth token）改仓库设置。
# token 只在进程内传递，不打印、不落盘。
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
'@
Add-Type -TypeDefinition $source

function Get-Token([string]$target) {
  $ptr = [IntPtr]::Zero
  if (-not [Cred]::CredRead($target, 1, 0, [ref]$ptr)) { throw "CredRead failed for $target" }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Cred+CREDENTIAL])
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    $utf8 = [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0)
    $utf16 = [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0)
    foreach ($candidate in @($utf8, $utf16)) {
      if ($candidate -match '^(gh[pousr]_|github_pat_)[A-Za-z0-9_]+$' -or $candidate -match '^[0-9a-f]{40}$') { return $candidate }
    }
    if ($utf8.Length -gt 20) { return $utf8 }
    return $utf16
  }
  finally { [Cred]::CredFree($ptr) }
}

$token = Get-Token 'GitHub - https://api.github.com/M0Yun'
if (-not $token) { throw 'no token found' }

$node = 'C:\Users\19232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$script = Join-Path $PSScriptRoot 'github-api.mjs'

$env:GH_TOKEN = $token
$env:NODE_USE_ENV_PROXY = '1'
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'

try {
  & $node $script @args
  exit $LASTEXITCODE
}
finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
}
