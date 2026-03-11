; Kill running JimboMesh Holler processes before install/upgrade.
!macro NSIS_HOOK_PREINSTALL
  ; Kill the Tauri app process if currently running.
  nsExec::ExecToLog 'taskkill /f /im "JimboMesh Holler.exe" 2>nul'

  ; Kill orphaned node.exe processes that include holler in command line.
  nsExec::ExecToLog 'wmic process where "name='"'"'node.exe'"'"' and commandline like '"'"'%holler%'"'"'" call terminate 2>nul'

  ; Allow file handles to release before cleanup.
  Sleep 2000

  ; Remove stale server bundle only; preserve data and root-level .env.
  RMDir /r "$LOCALAPPDATA\ai.jimbomesh.holler\server"
!macroend
