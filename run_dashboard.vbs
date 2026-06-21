' ===========================================================================
' No-console launcher for the Investment Dashboard (Windows).
' ---------------------------------------------------------------------------
' Double-click this file to start the dashboard with NO command window: it runs
' run_dashboard.py under the windowless pythonw.exe, which opens your browser
' and handles everything else in the background.
'
' If startup fails before the server is up, run_dashboard.py shows a native
' error dialog and writes the full details to launcher.log beside this file, so
' a silent double-click never just "does nothing".
'
' Want to watch live output instead? Use run_dashboard.bat (the console /
' diagnostic launcher) — it keeps a window open and prints everything.
' ===========================================================================

Option Explicit

Dim fso, shell, here, venvPythonw, exe, ok, probe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

' Prefer the project's own windowless interpreter once .venv exists (steady
' state); on the very first run fall back to a pythonw.exe on PATH, which
' run_dashboard.py uses to build .venv and then relaunches into.
venvPythonw = here & "\.venv\Scripts\pythonw.exe"
If fso.FileExists(venvPythonw) Then
    exe = venvPythonw
Else
    exe = "pythonw.exe"
End If

' Verify a suitable (3.12+) windowless Python is reachable. shell.Run with
' bWaitOnReturn=True returns the exit code; a missing exe raises, which we
' treat as "not found".
ok = False
On Error Resume Next
probe = shell.Run("""" & exe & """ -c ""import sys;sys.exit(0 if sys.version_info>=(3,12) else 1)""", 0, True)
If Err.Number = 0 And probe = 0 Then ok = True
On Error Goto 0

If ok Then
    ' windowStyle 0 = hidden, bWaitOnReturn False = fire and forget.
    shell.Run """" & exe & """ """ & here & "\run_dashboard.py""", 0, False
Else
    ' No usable windowless Python found — hand off to the console launcher so
    ' the user sees the actionable "install Python 3.12+" guidance.
    shell.Run """" & here & "\run_dashboard.bat""", 1, False
End If
