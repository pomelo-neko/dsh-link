' hub-daemon.vbs - run hub-daemon.ps1 with no console window (logon task).
' Usage: wscript hub-daemon.vbs [installDir] [dataDir]
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\hub-daemon.ps1"
installDir = here
dataDir = ""
If WScript.Arguments.Count >= 1 Then installDir = WScript.Arguments(0)
If WScript.Arguments.Count >= 2 Then dataDir = WScript.Arguments(1)
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & script & """ -InstallDir """ & installDir & """"
If Len(dataDir) > 0 Then cmd = cmd & " -DataDir """ & dataDir & """"
sh.Run cmd, 0, False
