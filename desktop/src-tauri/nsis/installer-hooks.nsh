; JimboMesh Holler - NSIS preinstall hook
; Kills running processes and removes stale server bundle before upgrade.
; Preserves data/ (SQLite) and root-level .env.

!macro NSIS_HOOK_PREINSTALL
  ; 1. Kill the Tauri desktop app
  nsExec::ExecToLog 'taskkill /f /im "JimboMesh Holler.exe" 2>nul'

  ; 2. Kill ALL node.exe processes - child processes spawned by Tauri
  ;    don't always show "holler" in the command line, so we must kill broadly.
  ;    This is acceptable during an installer run - user expects app restart.
  nsExec::ExecToLog 'taskkill /f /im node.exe 2>nul'

  ; 3. Kill Ollama if running - it may hold file locks on model-related files
  ;    or shared SQLite resources
  nsExec::ExecToLog 'taskkill /f /im ollama.exe 2>nul'
  nsExec::ExecToLog 'taskkill /f /im "ollama app.exe" 2>nul'

  ; 4. Wait for Windows to fully release all file handles
  ;    Windows is slower than Unix at handle release after process termination
  Sleep 5000

  ; 5. Delete the stale server bundle directory
  ;    Retry once after a brief pause if the first attempt fails
  ;    (handles may still be releasing on slow machines)
  RMDir /r "$LOCALAPPDATA\ai.jimbomesh.holler\server"
  Sleep 2000
  RMDir /r "$LOCALAPPDATA\ai.jimbomesh.holler\server"

  ; NOTE: Do NOT delete these - they contain user data:
  ;   $LOCALAPPDATA\ai.jimbomesh.holler\data\   (SQLite database)
  ;   $LOCALAPPDATA\ai.jimbomesh.holler\.env     (root-level config, if exists)
!macroend
