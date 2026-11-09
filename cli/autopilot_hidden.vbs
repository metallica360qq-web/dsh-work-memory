' Launch autopilot.cmd with a hidden console window.
' Registered as Windows scheduled task "DSH-work-memory-autopilot":
'   wscript.exe //nologo //B "<this file>"
' Keeps stdout/stderr redirection inside autopilot.cmd, so the run stays silent
' and nothing pops up on the desktop.
Option Explicit
Dim fso, sh, here, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "autopilot.cmd")
sh.Run "cmd.exe /c """ & target & """", 0, False
