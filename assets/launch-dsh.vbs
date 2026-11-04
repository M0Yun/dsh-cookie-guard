Option Explicit

' DSH launcher: prune stale dsh-auth-* cookies, then start DeepSeek Harness.
' All decisions live in start-dsh.ps1; this file only hides the console window.
Dim fso, sh, base, ps1

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(base, "start-dsh.ps1")

sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, True
