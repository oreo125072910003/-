' Start dsh-pc-bridge in background (no window).
' Script resolves its own directory, so the folder can be moved freely.
' Log file is bridge.log in the same folder.
Dim fso, sh, here, py, srv
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
py = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\pythonw.exe"
srv = here & "\mcp_dsh_server.py"

If Not fso.FileExists(py) Then
  py = "pythonw.exe"
End If

' Route MCP server and its child processes through local proxy (NICE / mihomo)
sh.CurrentDirectory = here
sh.Run """" & py & """ """ & srv & """ --host 0.0.0.0 --port 8765", 0, False
