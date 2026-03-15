; JimboMesh Holler - NSIS preinstall hook
; Ensures stale desktop/runtime processes are stopped before files are replaced.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping JimboMesh Holler..."

  ; Kill common Holler desktop process names.
  nsExec::ExecToLog 'taskkill /F /IM "jimbomesh-holler.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "JimboMesh Holler.exe"'

  ; Kill orphaned node.exe launched from this app path.
  nsExec::ExecToLog 'cmd /c "wmic process where (name=\"node.exe\" and commandline like \"%ai.jimbomesh.holler%\") call terminate"'

  ; Fallback: if command-line matching fails, kill remaining node.exe.
  nsExec::ExecToLog 'taskkill /F /IM "node.exe"'

  ; Give Windows time to release file handles.
  Sleep 2000

  ; Best-effort cleanup of stale runtime folders.
  RMDir /r "$LOCALAPPDATA\ai.jimbomesh.holler\server"
  RMDir /r "$LOCALAPPDATA\ai.jimbomesh.holler\installers"

  DetailPrint "JimboMesh Holler stopped."
!macroend
