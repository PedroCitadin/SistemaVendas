Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c node app.js", 1
Set WshShell = Nothing