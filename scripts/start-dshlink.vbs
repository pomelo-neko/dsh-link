' start-dshlink.vbs — run start-dshlink.ps1 with no console window (logon task / shortcut).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\start-dshlink.ps1"
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, False
