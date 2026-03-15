use flate2::read::GzDecoder;
use std::fs::{self, File, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tar::Archive;
use tauri::Manager;
use tokio::process::Command;

use crate::AppState;

const NODEJS_MAJOR: &str = "22";
const NODEJS_INDEX_URL: &str = "https://nodejs.org/dist/index.json";
const OLLAMA_WINDOWS_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
const SERVER_BUNDLE_BASE_URL: &str =
    "https://github.com/IngressTechnology/jimbomesh-holler-server/releases/latest/download";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub root_dir: PathBuf,
    pub server_dir: PathBuf,
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub installers_dir: PathBuf,
    pub env_file: PathBuf,
    pub db_file: PathBuf,
    pub holler_log_file: PathBuf,
}

#[derive(Debug, serde::Deserialize)]
struct NodeRelease {
    version: String,
}

/// Check whether a port is already bound on localhost.
pub fn is_port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// Check whether Ollama is already listening on port 11434.
pub async fn is_ollama_running() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get("http://127.0.0.1:11434/api/version")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub async fn node_version() -> Result<String, String> {
    let node = find_node()?;
    command_version(&node, "--version", "Node.js").await
}

pub async fn ollama_version() -> Result<String, String> {
    let ollama = which_ollama().ok_or_else(|| "Ollama not found".to_string())?;
    let output = Command::new(&ollama)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run `{}` --version: {e}", ollama.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");

    if let Some(version) = parse_ollama_version(&combined) {
        return Ok(version);
    }

    if !output.status.success() {
        let details = stderr.trim();
        return Err(if details.is_empty() {
            "Ollama check failed: `ollama --version` exited unsuccessfully".to_string()
        } else {
            format!("Ollama check failed: {details}")
        });
    }

    Err("Ollama check returned an empty version string".to_string())
}

/// Resolve and verify a working Node.js runtime by running `node --version`.
pub async fn ensure_node_available() -> Result<PathBuf, String> {
    let node = find_node()?;
    let version = command_version(&node, "--version", "Node.js").await?;
    eprintln!("[holler-desktop] Using Node.js {version}");
    Ok(node)
}

pub async fn install_node(app: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let paths = runtime_paths(app)?;
        let (version, url) = latest_node_windows_msi().await?;
        let installer_path = paths.installers_dir.join(format!("node-{version}.msi"));
        download_to_file(&url, &installer_path).await?;
        run_installer(
            "msiexec",
            &[
                "/i",
                installer_path.to_string_lossy().as_ref(),
                "/qn",
                "/norestart",
            ],
            "Node.js installer",
        )
        .await?;

        // MSI returns before PATH propagation; probe until the binary appears.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(version) = node_version().await {
                return Ok(version);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Node.js installation completed but `node --version` is still unavailable."
                        .to_string(),
                );
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Automatic Node.js installation is currently only implemented on Windows. Download Node.js from https://nodejs.org".to_string())
    }
}

pub async fn install_ollama(app: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let paths = runtime_paths(app)?;
        let installer_path = paths.installers_dir.join("OllamaSetup.exe");
        download_to_file(OLLAMA_WINDOWS_URL, &installer_path).await?;
        run_installer(
            installer_path.to_string_lossy().as_ref(),
            &["/S"],
            "Ollama installer",
        )
        .await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(version) = ollama_version().await {
                return Ok(version);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Ollama installation completed but `ollama --version` is still unavailable."
                        .to_string(),
                );
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Automatic Ollama installation is currently only implemented on Windows. Download Ollama from https://ollama.com/download".to_string())
    }
}

pub async fn ensure_server_bundle(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(existing) = find_holler_server_dir(app) {
        if is_server_bundle_current(&existing) {
            return Ok(existing);
        }

        let paths = runtime_paths(app)?;
        if existing == paths.server_dir {
            eprintln!(
                "[holler-desktop] Stale server bundle detected at {}",
                existing.display()
            );

            let env_backup_path = paths.root_dir.join(".env.upgrade-backup");
            if paths.env_file.exists() {
                fs::copy(&paths.env_file, &env_backup_path)
                    .map_err(|e| format!("Cannot backup .env before upgrade: {e}"))?;
            }

            prepare_server_dir_for_upgrade(&paths.root_dir, &existing)
                .map_err(|e| format!("Cannot remove stale server bundle: {e}"))?;
        } else {
            eprintln!(
                "[holler-desktop] Stale server bundle detected at {}, using managed runtime server path for upgrade",
                existing.display()
            );
        }
    }

    let paths = runtime_paths(app)?;
    let asset_name = server_bundle_asset_name()?;
    let bundle_url = format!("{SERVER_BUNDLE_BASE_URL}/{asset_name}");
    let archive_path = paths.installers_dir.join(&asset_name);

    download_to_file(&bundle_url, &archive_path).await?;

    if paths.server_dir.exists() {
        prepare_server_dir_for_upgrade(&paths.root_dir, &paths.server_dir)
            .map_err(|e| format!("Cannot replace existing server bundle: {e}"))?;
    }
    fs::create_dir_all(&paths.server_dir).map_err(|e| format!("Cannot create server dir: {e}"))?;
    extract_tar_gz(&archive_path, &paths.server_dir)?;

    if !paths.server_dir.join("api-gateway.js").is_file() {
        return Err("Downloaded Holler server bundle did not contain `api-gateway.js`.".into());
    }

    let env_backup = paths.root_dir.join(".env.upgrade-backup");
    if env_backup.exists() {
        let target = paths.server_dir.join(".env");
        if let Err(e) = fs::rename(&env_backup, &target) {
            eprintln!("[holler-desktop] Warning: could not restore .env backup: {e}");
        } else {
            eprintln!("[holler-desktop] Restored .env from pre-upgrade backup");
        }
    }

    Ok(paths.server_dir)
}

fn prepare_server_dir_for_upgrade(root_dir: &Path, server_dir: &Path) -> Result<(), String> {
    if !server_dir.exists() {
        return Ok(());
    }

    // Delete is the fast path on Unix and when no handles are open.
    for attempt in 1..=3 {
        match fs::remove_dir_all(server_dir) {
            Ok(_) => {
                eprintln!("[holler-desktop] Stale bundle deleted (attempt {attempt})");
                return Ok(());
            }
            Err(e) => {
                eprintln!(
                    "[holler-desktop] Delete attempt {attempt}/3 failed: {e} — retrying in 2s"
                );
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }

    // Windows lock workaround: move aside and continue with a fresh server dir.
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let old_name = root_dir.join(format!("server.old.{timestamp}"));

    fs::rename(server_dir, &old_name).map_err(|e| {
        format!(
            "Delete retries failed and rename fallback to {} also failed: {e}",
            old_name.display()
        )
    })?;

    eprintln!(
        "[holler-desktop] Stale bundle renamed to {} (locked files workaround)",
        old_name.display()
    );
    Ok(())
}

/// Remove any leftover server.old.* directories from previous upgrades.
/// Called during startup when no file locks should exist.
pub fn cleanup_old_bundles(app: &tauri::AppHandle) {
    if let Ok(paths) = runtime_paths(app) {
        if let Ok(entries) = fs::read_dir(&paths.root_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("server.old.") {
                    match fs::remove_dir_all(&path) {
                        Ok(_) => {
                            eprintln!("[holler-desktop] Cleaned up old bundle: {}", path.display())
                        }
                        Err(e) => eprintln!(
                            "[holler-desktop] Could not clean up {}: {} (will retry next launch)",
                            path.display(),
                            e
                        ),
                    }
                }
            }
        }
    }
}

pub fn runtime_paths(app: &tauri::AppHandle) -> Result<RuntimePaths, String> {
    let root_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot resolve local app data dir: {e}"))?;

    let paths = RuntimePaths {
        server_dir: root_dir.join("server"),
        data_dir: root_dir.join("data"),
        logs_dir: root_dir.join("logs"),
        installers_dir: root_dir.join("installers"),
        env_file: root_dir.join("server").join(".env"),
        db_file: root_dir.join("data").join("holler.db"),
        holler_log_file: root_dir.join("logs").join("holler.log"),
        root_dir,
    };

    fs::create_dir_all(&paths.root_dir).map_err(|e| format!("Cannot create app root dir: {e}"))?;
    fs::create_dir_all(&paths.data_dir).map_err(|e| format!("Cannot create data dir: {e}"))?;
    fs::create_dir_all(&paths.logs_dir).map_err(|e| format!("Cannot create logs dir: {e}"))?;
    fs::create_dir_all(&paths.installers_dir)
        .map_err(|e| format!("Cannot create installers dir: {e}"))?;

    Ok(paths)
}

/// Locate a nearby Holler server checkout/bundle containing `api-gateway.js`.
pub fn find_holler_server_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    for candidate in holler_server_candidates(app) {
        if candidate.join("api-gateway.js").is_file() {
            eprintln!(
                "[holler-desktop] Found Holler server at {}",
                candidate.display()
            );
            return Some(candidate);
        }
    }

    None
}

/// Check if the installed server bundle version matches the desktop app version.
/// Returns `true` if versions match, `false` if stale or unreadable.
pub fn is_server_bundle_current(server_dir: &Path) -> bool {
    let pkg_path = server_dir.join("package.json");
    let app_version = env!("CARGO_PKG_VERSION");

    let contents = match fs::read_to_string(&pkg_path) {
        Ok(c) => c,
        Err(_) => {
            eprintln!(
                "[holler-desktop] Cannot read {}, treating as stale",
                pkg_path.display()
            );
            return false;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) => {
            eprintln!(
                "[holler-desktop] Cannot parse {}, treating as stale",
                pkg_path.display()
            );
            return false;
        }
    };

    let server_version = parsed["version"].as_str().unwrap_or("0.0.0");

    if server_version == app_version {
        eprintln!(
            "[holler-desktop] Server bundle version {server_version} matches app version"
        );
        true
    } else {
        eprintln!(
            "[holler-desktop] Server bundle STALE: bundle={server_version} app={app_version} -- will re-extract"
        );
        false
    }
}

fn which_ollama() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            dirs::home_dir().map(|h| {
                h.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("Ollama")
                    .join("ollama.exe")
            }),
            Some(std::path::PathBuf::from(
                r"C:\Program Files\Ollama\ollama.exe",
            )),
        ];
        for c in candidates.into_iter().flatten() {
            if c.exists() {
                return Some(c);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let candidates = [
            std::path::PathBuf::from("/usr/local/bin/ollama"),
            std::path::PathBuf::from("/opt/homebrew/bin/ollama"),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let p = std::path::PathBuf::from("/usr/local/bin/ollama");
        if p.exists() {
            return Some(p);
        }
    }

    // Fallback: try PATH
    which::which("ollama").ok()
}

fn apply_background_process_flags(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Start `ollama serve` as a child process.
pub async fn start_ollama(app: &tauri::AppHandle) -> Result<(), String> {
    if is_ollama_running().await {
        eprintln!("[holler-desktop] Ollama already running on :11434");
        return Ok(());
    }

    let bin = which_ollama().ok_or_else(|| "Ollama not found".to_string())?;

    let mut cmd = Command::new(bin);
    cmd.arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    apply_background_process_flags(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {e}"))?;

    let state = app.state::<AppState>();
    *state.ollama_process.lock().unwrap() = Some(child);
    eprintln!("[holler-desktop] Started ollama serve");

    // Wait for Ollama to become responsive
    wait_for_url("http://127.0.0.1:11434/api/version", 30).await?;
    Ok(())
}

/// Start the Holler Node.js gateway as a child process.
pub async fn start_holler(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let paths = runtime_paths(app)?;
    let server_dir = app_server_dir(app)?;
    let node = ensure_node_available().await?;
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.holler_log_file)
        .map_err(|e| format!("Cannot open Holler log file: {e}"))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("Cannot clone Holler log handle: {e}"))?;

    let mut cmd = Command::new(&node);
    cmd.arg(server_dir.join("api-gateway.js"))
        .current_dir(&server_dir)
        .env("GATEWAY_PORT", port.to_string())
        .env("ADMIN_ENABLED", "true")
        .env("DOTENV_PATH", &paths.env_file)
        .env("OLLAMA_INTERNAL_URL", "http://127.0.0.1:11434")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err))
        .kill_on_drop(true);
    apply_background_process_flags(&mut cmd);

    // Pass through generated API key and runtime config from the server-local env file.
    if paths.env_file.exists() {
        if let Ok(contents) = std::fs::read_to_string(&paths.env_file) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    cmd.env(k.trim(), v.trim());
                }
            }
        }
    }

    // Point SQLITE_DB_PATH into the app data dir
    cmd.env(
        "SQLITE_DB_PATH",
        paths.db_file.to_string_lossy().to_string(),
    );

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Holler server: {e}"))?;
    let child_id = child.id();

    let state = app.state::<AppState>();
    *state.keep_holler_running.lock().unwrap() = true;
    *state.holler_process.lock().unwrap() = Some(child);
    eprintln!("[holler-desktop] Started Holler gateway on port {port}");

    let health_url = format!("http://127.0.0.1:{port}/health");
    wait_for_url(&health_url, 30).await?;

    *state.server_ready.lock().unwrap() = true;
    monitor_holler_exit(app.clone(), port, child_id);

    Ok(())
}

fn monitor_holler_exit(app: tauri::AppHandle, port: u16, expected_child_id: Option<u32>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;

            let exit_status = {
                let state = app.state::<AppState>();
                let mut guard = state.holler_process.lock().unwrap();

                match guard.as_mut() {
                    Some(child) if child.id() == expected_child_id => match child.try_wait() {
                        Ok(Some(status)) => {
                            let _ = guard.take();
                            Some(status)
                        }
                        Ok(None) => None,
                        Err(err) => {
                            eprintln!(
                                "[holler-desktop] Failed to inspect Holler process state: {err}"
                            );
                            None
                        }
                    },
                    _ => return,
                }
            };

            let Some(status) = exit_status else {
                continue;
            };

            {
                let state = app.state::<AppState>();
                *state.server_ready.lock().unwrap() = false;
            }
            crate::update_tray_menu(&app);

            let should_restart = {
                let state = app.state::<AppState>();
                let keep_running = *state.keep_holler_running.lock().unwrap();
                keep_running
            };
            if !should_restart {
                return;
            }

            eprintln!(
                "[holler-desktop] Server crashed, restarting... (exit status: {status})"
            );
            tokio::time::sleep(Duration::from_secs(2)).await;

            let should_restart = {
                let state = app.state::<AppState>();
                let keep_running = *state.keep_holler_running.lock().unwrap();
                keep_running
            };
            if !should_restart {
                return;
            }

            if let Err(err) = start_holler(&app, port).await {
                eprintln!("[holler-desktop] Failed to restart Holler server: {err}");
            }
            crate::update_tray_menu(&app);
            return;
        }
    });
}

/// Verify the extracted Holler server bundle includes its local Node.js
/// dependencies. sql.js is pure JavaScript, so no ABI-specific rebuild step is
/// required anymore.
pub async fn verify_server_bundle(server_dir: &Path) -> Result<(), String> {
    let package_json = server_dir.join("package.json");
    if !package_json.exists() {
        return Err(format!(
            "Holler server bundle is incomplete: missing {}",
            package_json.display()
        ));
    }

    let sql_js_package = server_dir
        .join("node_modules")
        .join("sql.js")
        .join("package.json");
    if !sql_js_package.exists() {
        return Err(format!(
            "Holler server bundle is missing the local sql.js dependency at {}",
            sql_js_package.display()
        ));
    }

    eprintln!(
        "[holler-desktop] Verified bundled server dependencies in {}",
        server_dir.display()
    );
    Ok(())
}

/// Poll a URL until it returns 2xx, with a timeout in seconds.
pub async fn wait_for_url(url: &str, timeout_secs: u64) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        if tokio::time::Instant::now() > deadline {
            return Err(format!("{url} did not become ready within {timeout_secs}s"));
        }
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}

/// Stop only the Holler server child process.
pub fn stop_holler(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    *state.keep_holler_running.lock().unwrap() = false;

    let mut guard = state.holler_process.lock().unwrap();
    if let Some(mut child) = guard.take() {
        eprintln!("[holler-desktop] Stopping Holler server");
        let _ = child.start_kill();
    }
    drop(guard);

    *state.server_ready.lock().unwrap() = false;
}

/// Kill all managed child processes on app exit.
pub fn kill_children(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    *state.keep_holler_running.lock().unwrap() = false;

    let mut guard = state.holler_process.lock().unwrap();
    if let Some(mut child) = guard.take() {
        eprintln!("[holler-desktop] Stopping Holler server");
        let _ = child.start_kill();
    }
    drop(guard);

    let mut guard = state.ollama_process.lock().unwrap();
    if let Some(mut child) = guard.take() {
        eprintln!("[holler-desktop] Stopping Ollama");
        let _ = child.start_kill();
    }
    drop(guard);
}

/// Resolve the bundled server code directory.
/// Searches the managed local install first, then development/resource fallbacks.
fn app_server_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    find_holler_server_dir(app).ok_or_else(|| {
        "JimboMesh Holler server not found. Install the server or use Docker.".to_string()
    })
}

/// Find a Node.js binary. Checks common locations then PATH.
fn find_node() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            dirs::data_local_dir().map(|d| d.join("Programs").join("nodejs").join("node.exe")),
            Some(std::path::PathBuf::from(
                r"C:\Program Files\nodejs\node.exe",
            )),
            Some(std::path::PathBuf::from(
                r"C:\Program Files (x86)\nodejs\node.exe",
            )),
        ];
        for c in candidates.into_iter().flatten() {
            if c.exists() {
                return Ok(c);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let candidates = [
            std::path::PathBuf::from("/usr/local/bin/node"),
            std::path::PathBuf::from("/usr/bin/node"),
            std::path::PathBuf::from("/opt/homebrew/bin/node"),
        ];
        for c in candidates {
            if c.exists() {
                return Ok(c);
            }
        }
    }

    which::which("node")
        .map_err(|_| "Node.js not found. Install Node.js 22+ from https://nodejs.org".to_string())
}

fn holler_server_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(paths) = runtime_paths(app) {
        push_candidate(&mut candidates, paths.server_dir);
    }

    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo_root) = manifest.parent().and_then(|p| p.parent()) {
            push_candidate(&mut candidates, repo_root.to_path_buf());
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            push_candidate(&mut candidates, parent.to_path_buf());
            push_candidate(&mut candidates, parent.join("server"));

            if let Some(grandparent) = parent.parent() {
                push_candidate(&mut candidates, grandparent.to_path_buf());
                push_candidate(&mut candidates, grandparent.join("server"));
            }
        }
    }

    if let Some(local_data) = dirs::data_local_dir() {
        push_candidate(
            &mut candidates,
            local_data.join("JimboMesh Holler").join("server"),
        );
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_candidate(&mut candidates, resource_dir.clone());
        push_candidate(&mut candidates, resource_dir.join("server"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        push_candidate(&mut candidates, cwd.clone());
        push_candidate(&mut candidates, cwd.join("server"));
    }

    candidates
}

fn push_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.contains(&path) {
        candidates.push(path);
    }
}

async fn command_version(binary: &Path, flag: &str, label: &str) -> Result<String, String> {
    let output = Command::new(binary)
        .arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run `{}` {flag}: {e}", binary.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let details = stderr.trim();
        return Err(if details.is_empty() {
            format!(
                "{label} check failed: `{}` {flag} exited unsuccessfully",
                binary.display()
            )
        } else {
            format!("{label} check failed: {details}")
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        Err(format!("{label} check returned an empty version string"))
    } else {
        Ok(stdout)
    }
}

fn parse_ollama_version(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|raw| {
        let token =
            raw.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'));
        let normalized = token.strip_prefix('v').unwrap_or(token);
        let has_three_parts = normalized.split('.').count() >= 3;
        let is_semverish = !normalized.is_empty()
            && normalized.chars().all(|c| c.is_ascii_digit() || c == '.')
            && has_three_parts
            && normalized
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit());

        if is_semverish {
            Some(format!("v{normalized}"))
        } else {
            None
        }
    })
}

async fn latest_node_windows_msi() -> Result<(String, String), String> {
    let releases: Vec<NodeRelease> = reqwest::get(NODEJS_INDEX_URL)
        .await
        .map_err(|e| format!("Failed to query Node.js releases: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse Node.js release index: {e}"))?;

    let release = releases
        .into_iter()
        .find(|r| r.version.starts_with(&format!("v{NODEJS_MAJOR}.")))
        .ok_or_else(|| format!("No Node.js {NODEJS_MAJOR}.x release found"))?;

    let url = format!(
        "https://nodejs.org/dist/{version}/node-{version}-x64.msi",
        version = release.version
    );
    Ok((release.version, url))
}

async fn run_installer(command: &str, args: &[&str], label: &str) -> Result<(), String> {
    let status = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("Failed to launch {label}: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("{label} exited with status {status}"))
    }
}

async fn download_to_file(url: &str, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create download dir: {e}"))?;
    }

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to download {url}: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("Download failed for {url}: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed reading download body from {url}: {e}"))?;

    fs::write(destination, &bytes)
        .map_err(|e| format!("Cannot write {}: {e}", destination.display()))
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|e| format!("Cannot open {}: {e}", archive_path.display()))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|e| format!("Cannot extract {}: {e}", archive_path.display()))
}

fn server_bundle_asset_name() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        Ok("holler-server-bundle-windows-x64.tar.gz".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        Ok("holler-server-bundle-macos-universal.tar.gz".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        Ok("holler-server-bundle-linux-x64.tar.gz".to_string())
    }
}
