use crate::{config, process};
use rand::Rng;
use std::collections::HashMap;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const NODEJS_DOWNLOAD_URL: &str = "https://nodejs.org";
const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";
const HOLLER_SERVER_INSTALL_URL: &str =
    "https://github.com/IngressTechnology/jimbomesh-holler-server";
const HOLLER_SERVER_NOT_FOUND_MESSAGE: &str =
    "JimboMesh Holler server not found. Please install from https://github.com/IngressTechnology/jimbomesh-holler-server or use Docker.";
const SERVER_BUNDLE_VALIDATION_FAILED_MESSAGE: &str =
    "Bundled Holler dependencies are missing or incomplete. Please reinstall the desktop bundle.";
const SETUP_COMPLETE_MESSAGE: &str = "Setup complete. Opening your local Holler admin now.";
const WIZARD_WAITING: &str = "Waiting";
const STARTER_MODEL_STEP_LABEL: &str = "Starter Models";
const STARTER_MODEL_SUMMARY: &str = "Downloading starter models so chat and embeddings work right away.";

const STARTER_MODELS: [StarterModel; 2] = [
    StarterModel {
        name: "llama3.2:1b",
        label: "llama3.2:1b",
        purpose: "chat",
    },
    StarterModel {
        name: "nomic-embed-text",
        label: "nomic-embed-text",
        purpose: "embeddings",
    },
];

#[derive(Clone, Copy)]
struct StarterModel {
    name: &'static str,
    label: &'static str,
    purpose: &'static str,
}

#[derive(Default, Clone)]
struct PullProgress {
    status: String,
    completed: Option<u64>,
    total: Option<u64>,
}

#[derive(serde::Deserialize)]
struct OllamaPullEvent {
    #[serde(default)]
    status: String,
    completed: Option<u64>,
    total: Option<u64>,
    error: Option<String>,
}

#[derive(Clone)]
struct SetupWizard {
    headline: String,
    detail: String,
    node: StepDisplay,
    ollama: StepDisplay,
    server: StepDisplay,
    model: StepDisplay,
}

#[derive(Clone)]
struct StepDisplay {
    label: &'static str,
    state: StepState,
    detail: String,
}

#[derive(Clone)]
enum StepState {
    Waiting,
    Working,
    Done,
    Failed,
}

impl SetupWizard {
    fn new() -> Self {
        Self {
            headline: "Setting up your local AI compute node...".into(),
            detail: "This only happens once. Go grab a coffee while Holler gets ready.".into(),
            node: StepDisplay::waiting("Node.js"),
            ollama: StepDisplay::waiting("Ollama"),
            server: StepDisplay::waiting("Holler Server"),
            model: StepDisplay::waiting(STARTER_MODEL_STEP_LABEL),
        }
    }

    fn progress_percent(&self) -> u8 {
        let steps = [&self.node, &self.ollama, &self.server, &self.model];

        let completed: u16 = steps
            .iter()
            .map(|step| match step.state {
                StepState::Done => 2_u16,
                StepState::Working => 1_u16,
                StepState::Waiting | StepState::Failed => 0,
            })
            .sum();

        ((completed * 100) / 8).min(100) as u8
    }
}

impl StepDisplay {
    fn waiting(label: &'static str) -> Self {
        Self {
            label,
            state: StepState::Waiting,
            detail: WIZARD_WAITING.into(),
        }
    }

    fn working(label: &'static str, detail: impl Into<String>) -> Self {
        Self {
            label,
            state: StepState::Working,
            detail: detail.into(),
        }
    }

    fn done(label: &'static str, detail: impl Into<String>) -> Self {
        Self {
            label,
            state: StepState::Done,
            detail: detail.into(),
        }
    }

    fn failed(label: &'static str, detail: impl Into<String>) -> Self {
        Self {
            label,
            state: StepState::Failed,
            detail: detail.into(),
        }
    }

    fn status_symbol(&self) -> &'static str {
        match self.state {
            StepState::Waiting => "⬜",
            StepState::Working => "⏳",
            StepState::Done => "✅",
            StepState::Failed => "❌",
        }
    }
}

// ── Public entry points ─────────────────────────────────────────

/// Orchestrates startup. Reads .env, determines port, checks saved
/// preference, and either attaches, launches standalone, or shows a
/// dialog for the user to choose.
pub async fn launch_services(app: &tauri::AppHandle) -> Result<(), String> {
    let env = read_env_file(app).unwrap_or_default();
    let port = get_configured_port(&env);

    let state = app.state::<crate::AppState>();
    *state.port.lock().unwrap() = port;

    eprintln!("[holler-desktop] Configured port: {port}");

    let saved = config::load(app);
    let port_occupied = process::is_port_in_use(port);

    match saved.as_ref().map(|c| c.mode.as_str()) {
        Some("attach") if port_occupied => {
            eprintln!("[holler-desktop] Saved mode: attach, server running \u{2192} connecting");
            do_attach(app, port, &env).await
        }
        Some("attach") => {
            eprintln!("[holler-desktop] Saved mode: attach, server NOT running");
            handle_missing_server(app, port, &env).await
        }
        Some("standalone") => {
            eprintln!("[holler-desktop] Saved mode: standalone \u{2192} launching");
            do_standalone(app, port).await
        }
        _ => {
            if port_occupied {
                eprintln!("[holler-desktop] First launch, existing server detected");
                handle_existing_detected(app, port, &env).await
            } else {
                eprintln!("[holler-desktop] First launch, port free \u{2192} standalone");
                save_mode(app, "standalone", port);
                do_standalone(app, port).await
            }
        }
    }
}

/// Called from tray "Switch Mode" menu item. Stops any managed server,
/// then re-runs detection with a dialog regardless of saved preference.
pub async fn switch_mode(app: &tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<crate::AppState>();
        if *state.managed.lock().unwrap() {
            process::stop_holler(app);
        }
    }

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let env = read_env_file(app).unwrap_or_default();
    let port = get_configured_port(&env);

    let state = app.state::<crate::AppState>();
    *state.port.lock().unwrap() = port;

    if process::is_port_in_use(port) {
        return handle_existing_detected(app, port, &env).await;
    }

    let standalone = show_dialog(
        app,
        "Switch Mode",
        &format!(
            "No server detected on port {port}.\n\n\
             \u{2022} Standalone \u{2014} Start and manage your own server\n\
             \u{2022} Attach \u{2014} Save preference for when you start\n\
               an external server (Docker, CLI, etc.)"
        ),
        "Start Standalone",
        "Save Attach",
        MessageDialogKind::Info,
    )
    .await;

    if standalone {
        save_mode(app, "standalone", port);
        do_standalone(app, port).await
    } else {
        save_mode(app, "attach", port);
        Ok(())
    }
}

// ── Dialog flows ────────────────────────────────────────────────

/// First launch: existing server detected on port. Ask user what to do.
async fn handle_existing_detected(
    app: &tauri::AppHandle,
    port: u16,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let holler_name = env
        .get("HOLLER_SERVER_NAME")
        .cloned()
        .unwrap_or_else(|| "Unknown".into());

    let use_existing = show_dialog(
        app,
        "Existing JimboMesh Holler Detected",
        &format!(
            "An existing JimboMesh Holler is running.\n\n\
             Port: {port}\n\
             Holler Name: {holler_name}\n\n\
             Would you like to connect to this Holler\n\
             or set up a new standalone instance?"
        ),
        "Use Existing",
        "Install Standalone",
        MessageDialogKind::Info,
    )
    .await;

    if use_existing {
        save_mode(app, "attach", port);
        return do_attach(app, port, env).await;
    }

    handle_standalone_transition(app, port).await
}

/// User chose standalone but port is occupied. Guide them through
/// stopping the existing server with a retry loop.
async fn handle_standalone_transition(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let warning_msg = format!(
        "To run as a standalone desktop app, the existing\n\
         server on port {port} needs to be stopped first.\n\n\
         \u{2022} Docker: docker stop <container>\n\
         \u{2022} CLI: press Ctrl+C in the terminal\n\n\
         After stopping, click Continue."
    );

    loop {
        let cont = show_dialog(
            app,
            "\u{26a0} Standalone Setup",
            &warning_msg,
            "Continue",
            "Cancel",
            MessageDialogKind::Warning,
        )
        .await;

        if !cont {
            let env = read_env_file(app).unwrap_or_default();
            save_mode(app, "attach", port);
            return do_attach(app, port, &env).await;
        }

        if !process::is_port_in_use(port) {
            save_mode(app, "standalone", port);
            return do_standalone(app, port).await;
        }

        let retry = show_dialog(
            app,
            "Port Still in Use",
            &format!(
                "Port {port} is still occupied.\n\
                 Please stop the existing server first."
            ),
            "Retry",
            "Cancel",
            MessageDialogKind::Warning,
        )
        .await;

        if !retry {
            let env = read_env_file(app).unwrap_or_default();
            save_mode(app, "attach", port);
            return do_attach(app, port, &env).await;
        }
    }
}

/// Saved mode is "attach" but the server isn't running.
async fn handle_missing_server(
    app: &tauri::AppHandle,
    port: u16,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let start_standalone = show_dialog(
        app,
        "JimboMesh Holler",
        &format!(
            "Your Holler server isn't running on port {port}.\n\n\
             Would you like to start a standalone server,\n\
             or wait and try connecting again?"
        ),
        "Start Standalone",
        "Retry Connect",
        MessageDialogKind::Info,
    )
    .await;

    if start_standalone {
        save_mode(app, "standalone", port);
        return do_standalone(app, port).await;
    }

    if process::is_port_in_use(port) {
        return do_attach(app, port, env).await;
    }

    Err("Server not running. Please start your Holler server and relaunch.".into())
}

// ── Core actions ────────────────────────────────────────────────

/// Connect to an existing server (attach mode).
async fn do_attach(
    app: &tauri::AppHandle,
    port: u16,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    eprintln!("[holler-desktop] Attaching to existing Holler on port {port}");

    let health_url = format!("http://127.0.0.1:{port}/health");
    process::wait_for_url(&health_url, 10)
        .await
        .unwrap_or_else(|e| {
            eprintln!("[holler-desktop] Health check warning (proceeding anyway): {e}");
        });

    let state = app.state::<crate::AppState>();
    *state.server_ready.lock().unwrap() = true;
    *state.managed.lock().unwrap() = false;

    navigate_with_key_from(app, port, env);
    Ok(())
}

/// Full standalone setup: Ollama, env gen, model pull, start server.
async fn do_standalone(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    // Clean up leftover upgrade bundles from prior launches.
    process::cleanup_old_bundles(app);

    let mut wizard = SetupWizard::new();
    wizard.detail = "Checking local dependencies and downloading anything missing.".into();
    render_setup_wizard(app, &wizard);

    let node_version = loop {
        wizard.node = StepDisplay::working("Node.js", "Checking...");
        render_setup_wizard(app, &wizard);

        match process::node_version().await {
            Ok(version) => break version,
            Err(_) => {
                wizard.node = StepDisplay::working("Node.js", "Downloading and installing...");
                render_setup_wizard(app, &wizard);
                match process::install_node(app).await {
                    Ok(version) => break version,
                    Err(err) => {
                        wizard.node = StepDisplay::failed("Node.js", "Install failed");
                        wizard.detail = err.clone();
                        render_setup_wizard(app, &wizard);
                        prompt_install_node(app, &err).await;
                        wizard.detail =
                            "Waiting for Node.js. Install it, then close the dialog to retry."
                                .into();
                        render_setup_wizard(app, &wizard);
                    }
                }
            }
        }
    };
    wizard.node = StepDisplay::done("Node.js", format!("Installed ({node_version})"));
    render_setup_wizard(app, &wizard);

    wizard.server = StepDisplay::working("Holler Server", "Checking bundle...");
    render_setup_wizard(app, &wizard);
    let server_dir = if let Some(dir) = process::find_holler_server_dir(app) {
        if process::is_server_bundle_current(&dir) {
            dir
        } else {
            wizard.server = StepDisplay::working("Holler Server", "Upgrading to new version...");
            render_setup_wizard(app, &wizard);
            match process::ensure_server_bundle(app).await {
                Ok(dir) => dir,
                Err(err) => {
                    wizard.server = StepDisplay::failed("Holler Server", "Upgrade failed");
                    wizard.detail = err.clone();
                    render_setup_wizard(app, &wizard);
                    prompt_missing_holler_server(app).await;
                    return Err(err);
                }
            }
        }
    } else {
        wizard.server = StepDisplay::working("Holler Server", "Downloading bundle...");
        render_setup_wizard(app, &wizard);
        match process::ensure_server_bundle(app).await {
            Ok(dir) => dir,
            Err(err) => {
                wizard.server = StepDisplay::failed("Holler Server", "Download failed");
                wizard.detail = err.clone();
                render_setup_wizard(app, &wizard);
                prompt_missing_holler_server(app).await;
                return Err(err);
            }
        }
    };

    ensure_env(app)?;
    wizard.server = StepDisplay::working("Holler Server", "Verifying bundled dependencies...");
    wizard.detail =
        "Checking that the bundled server includes its local dependencies. No native rebuild is required."
            .into();
    render_setup_wizard(app, &wizard);
    if let Err(err) = process::verify_server_bundle(&server_dir).await {
        wizard.server = StepDisplay::failed("Holler Server", "Bundle verification failed");
        wizard.detail = err.clone();
        render_setup_wizard(app, &wizard);
        show_setup_error(
            app,
            "Bundled Dependencies Missing",
            &format!("{SERVER_BUNDLE_VALIDATION_FAILED_MESSAGE}\n\n{err}"),
        )
        .await;
        return Err(err);
    }
    wizard.server = StepDisplay::done("Holler Server", "Bundle ready");
    wizard.detail = "Checking local dependencies and downloading anything missing.".into();
    render_setup_wizard(app, &wizard);

    let (ollama_version, ollama_was_running) = loop {
        wizard.ollama = StepDisplay::working("Ollama", "Checking...");
        render_setup_wizard(app, &wizard);
        let was_running = process::is_ollama_running().await;

        match process::ollama_version().await {
            Ok(version) => break (version, was_running),
            Err(_) => {
                wizard.ollama = StepDisplay::working("Ollama", "Downloading and installing...");
                render_setup_wizard(app, &wizard);
                match process::install_ollama(app).await {
                    Ok(version) => break (version, was_running),
                    Err(err) => {
                        wizard.ollama = StepDisplay::failed("Ollama", "Install failed");
                        wizard.detail = err.clone();
                        render_setup_wizard(app, &wizard);
                        prompt_install_ollama(app, &err).await;
                        wizard.detail =
                            "Waiting for Ollama. Install it, then close the dialog to retry."
                                .into();
                        render_setup_wizard(app, &wizard);
                    }
                }
            }
        }
    };
    wizard.ollama = if ollama_was_running {
        StepDisplay::done("Ollama", format!("Running ({ollama_version})"))
    } else {
        StepDisplay::done(
            "Ollama",
            format!("Installed ({ollama_version}) - Not running yet"),
        )
    };
    render_setup_wizard(app, &wizard);

    loop {
        wizard.ollama = StepDisplay::working("Ollama", "Starting service...");
        render_setup_wizard(app, &wizard);
        if let Err(err) = process::start_ollama(app).await {
            wizard.ollama = StepDisplay::failed("Ollama", "Start failed");
            wizard.detail = err.clone();
            render_setup_wizard(app, &wizard);
            prompt_install_ollama(app, &err).await;
            wizard.detail =
                "Waiting for Ollama service. Start/install it, then close the dialog to retry."
                    .into();
            render_setup_wizard(app, &wizard);
            continue;
        }
        break;
    }
    wizard.ollama = StepDisplay::done("Ollama", format!("Running ({ollama_version})"));
    render_setup_wizard(app, &wizard);

    wizard.model = StepDisplay::working(
        STARTER_MODEL_STEP_LABEL,
        "Checking llama3.2:1b and nomic-embed-text...",
    );
    wizard.detail = STARTER_MODEL_SUMMARY.into();
    render_setup_wizard(app, &wizard);

    let mut ready_models = Vec::new();
    let mut failed_models = Vec::new();

    for (index, model) in STARTER_MODELS.iter().enumerate() {
        if is_model_installed(model.name).await? {
            ready_models.push(model.label);
            continue;
        }

        wizard.model = StepDisplay::working(
            STARTER_MODEL_STEP_LABEL,
            format!("Pulling {} ({}/{})...", model.label, index + 1, STARTER_MODELS.len()),
        );
        wizard.detail = STARTER_MODEL_SUMMARY.into();
        render_setup_wizard(app, &wizard);

        let mut last_detail = String::new();
        let pull_result = pull_model_with_progress(model.name, |progress| {
            let detail = format_pull_progress(model, index + 1, STARTER_MODELS.len(), progress);
            if detail != last_detail {
                last_detail = detail.clone();
                wizard.model = StepDisplay::working(STARTER_MODEL_STEP_LABEL, detail);
                wizard.detail = STARTER_MODEL_SUMMARY.into();
                render_setup_wizard(app, &wizard);
            }
        })
        .await;

        match pull_result {
            Ok(()) => ready_models.push(model.label),
            Err(err) => {
                failed_models.push(format!("{} ({})", model.label, err));
                wizard.model = StepDisplay::working(
                    STARTER_MODEL_STEP_LABEL,
                    format!("Couldn't pull {}. Continuing setup...", model.label),
                );
                wizard.detail = format!(
                    "Holler will still finish setup, but {} may need to be downloaded later from Models > Marketplace.",
                    model.purpose
                );
                render_setup_wizard(app, &wizard);
            }
        }
    }

    if failed_models.is_empty() {
        wizard.model = StepDisplay::done(
            STARTER_MODEL_STEP_LABEL,
            format!("Installed ({})", ready_models.join(", ")),
        );
        wizard.detail = "Starter chat and embedding models are ready.".into();
    } else {
        wizard.model = StepDisplay::done(
            STARTER_MODEL_STEP_LABEL,
            format!(
                "Installed {} of {}",
                ready_models.len(),
                STARTER_MODELS.len()
            ),
        );
        wizard.detail = format!(
            "Setup is continuing, but some starter downloads need a retry later: {}",
            failed_models.join("; ")
        );
    }
    render_setup_wizard(app, &wizard);

    wizard.server = StepDisplay::working(
        "Holler Server",
        format!("Starting from {}...", server_dir.display()),
    );
    render_setup_wizard(app, &wizard);
    process::start_holler(app, port).await?;
    let app_version = env!("CARGO_PKG_VERSION");
    wizard.server = StepDisplay::done("Holler Server", format!("Running (v{app_version})"));
    wizard.detail = SETUP_COMPLETE_MESSAGE.into();
    render_setup_wizard(app, &wizard);
    {
        let state = app.state::<crate::AppState>();
        *state.managed.lock().unwrap() = true;
    }

    let env = read_env_file(app).unwrap_or_default();
    schedule_setup_redirect(app, port, &env);

    Ok(())
}

// ── Dialog helper ───────────────────────────────────────────────

/// Show a two-button dialog and await the user's choice.
/// Returns `true` if the OK (first) button was pressed.
async fn show_dialog(
    app: &tauri::AppHandle,
    title: &str,
    message: &str,
    ok_label: &str,
    cancel_label: &str,
    kind: MessageDialogKind,
) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok_label.to_string(),
            cancel_label.to_string(),
        ))
        .show(move |result| {
            let _ = tx.send(result);
        });

    rx.await.unwrap_or(false)
}

// ── Config persistence ──────────────────────────────────────────

fn save_mode(app: &tauri::AppHandle, mode: &str, port: u16) {
    let cfg = config::DesktopConfig {
        mode: mode.to_string(),
        port,
        last_used: chrono_free_date(),
    };
    if let Err(e) = config::save(app, &cfg) {
        eprintln!("[holler-desktop] Failed to save config: {e}");
    }
    eprintln!("[holler-desktop] Saved mode: {mode}, port: {port}");
}

// ── Env + server helpers (unchanged) ────────────────────────────

fn get_configured_port(env: &HashMap<String, String>) -> u16 {
    env.get("GATEWAY_PORT")
        .or_else(|| env.get("OLLAMA_HOST_PORT"))
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(1920)
}

fn ensure_env(app: &tauri::AppHandle) -> Result<(), String> {
    let paths = process::runtime_paths(app)?;
    let env_path = paths.env_file.clone();
    if env_path.exists() {
        eprintln!(
            "[holler-desktop] Found existing .env at {}",
            env_path.display()
        );
        return Ok(());
    }

    std::fs::create_dir_all(&paths.server_dir).map_err(|e| e.to_string())?;
    let api_key = generate_hex_key(32);
    let qdrant_key = generate_hex_key(32);

    let contents = format!(
        "\
# Auto-generated by JimboMesh Holler Desktop \u{2014} {date}
JIMBOMESH_HOLLER_API_KEY={api_key}
QDRANT_API_KEY={qdrant_key}
HOLLER_MODELS=nomic-embed-text,llama3.2:1b
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_INTERNAL_URL=http://127.0.0.1:11434
GATEWAY_PORT=1920
ADMIN_ENABLED=true
RATE_LIMIT_PER_MIN=60
SQLITE_DB_PATH={db_path}
DOCUMENTS_COLLECTION=documents
",
        date = chrono_free_date(),
        api_key = api_key,
        qdrant_key = qdrant_key,
        db_path = paths.db_file.to_string_lossy(),
    );

    std::fs::write(&env_path, contents).map_err(|e| format!("Cannot write .env: {e}"))?;
    eprintln!(
        "[holler-desktop] Generated first-run .env at {}",
        env_path.display()
    );
    Ok(())
}

async fn pull_model_with_progress<F>(model: &str, mut on_progress: F) -> Result<(), String>
where
    F: FnMut(&PullProgress),
{
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "name": model,
        "stream": true
    });

    eprintln!("[holler-desktop] Pulling {model} (this may take a few minutes)...");

    let mut resp = client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Model pull request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Model pull returned {status}: {text}"));
    }

    let mut buffer = String::new();
    let mut last_progress = PullProgress::default();

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Model pull stream failed: {e}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_idx) = buffer.find('\n') {
            let line = buffer[..newline_idx].trim().to_string();
            buffer = buffer[newline_idx + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let event: OllamaPullEvent =
                serde_json::from_str(&line).map_err(|e| format!("Invalid pull progress from Ollama: {e}"))?;
            if let Some(err) = event.error {
                return Err(err);
            }
            last_progress = PullProgress {
                status: event.status,
                completed: event.completed,
                total: event.total,
            };
            on_progress(&last_progress);
        }
    }

    if !buffer.trim().is_empty() {
        let event: OllamaPullEvent =
            serde_json::from_str(buffer.trim()).map_err(|e| format!("Invalid pull progress from Ollama: {e}"))?;
        if let Some(err) = event.error {
            return Err(err);
        }
        last_progress = PullProgress {
            status: event.status,
            completed: event.completed,
            total: event.total,
        };
        on_progress(&last_progress);
    }

    if last_progress.status.is_empty() {
        on_progress(&PullProgress {
            status: "done".into(),
            completed: None,
            total: None,
        });
    }

    eprintln!("[holler-desktop] {model} ready");
    Ok(())
}

async fn is_model_installed(model: &str) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("Failed to query Ollama models: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("Failed to query Ollama models: {e}"))?;
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

    Ok(body["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["name"].as_str())
        .any(|installed| installed == model || installed.split(':').next() == Some(model)))
}

fn format_pull_progress(
    model: &StarterModel,
    current_index: usize,
    total_models: usize,
    progress: &PullProgress,
) -> String {
    let prefix = format!("{} ({}/{})", model.label, current_index, total_models);
    match (progress.completed, progress.total) {
        (Some(completed), Some(total)) if total > 0 => {
            let percent = ((completed as f64 / total as f64) * 100.0).round() as u64;
            format!(
                "{prefix} — {} {}% ({}/{})",
                prettify_pull_status(&progress.status),
                percent,
                format_size_mb(completed),
                format_size_mb(total)
            )
        }
        _ if !progress.status.is_empty() => {
            format!("{prefix} — {}", prettify_pull_status(&progress.status))
        }
        _ => format!("{prefix} — downloading..."),
    }
}

fn prettify_pull_status(status: &str) -> String {
    if status.is_empty() {
        return "Downloading".into();
    }
    let mut chars = status.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "Downloading".into(),
    }
}

fn format_size_mb(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else {
        format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

async fn prompt_install_ollama(app: &tauri::AppHandle, details: &str) {
    eprintln!("[holler-desktop] Ollama unavailable: {details}");
    let open_download = show_dialog(
        app,
        "Ollama Required",
        &format!(
            "JimboMesh Holler standalone mode requires Ollama.\n\n{details}\n\nInstall Ollama, then close this dialog to retry setup."
        ),
        "Open Ollama",
        "Close",
        MessageDialogKind::Error,
    )
    .await;

    if open_download {
        let _ = open::that(OLLAMA_DOWNLOAD_URL);
    }
}

async fn prompt_install_node(app: &tauri::AppHandle, details: &str) {
    eprintln!("[holler-desktop] Node.js not available: {details}");
    let open_download = show_dialog(
        app,
        "Node.js Required",
        &format!(
            "JimboMesh Holler standalone mode requires Node.js.\n\n{details}\n\nInstall Node.js, then close this dialog to retry setup."
        ),
        "Open Node.js",
        "Close",
        MessageDialogKind::Error,
    )
    .await;

    if open_download {
        let _ = open::that(NODEJS_DOWNLOAD_URL);
    }
}

async fn prompt_missing_holler_server(app: &tauri::AppHandle) {
    eprintln!("[holler-desktop] Standalone server bundle not found");
    let open_install = show_dialog(
        app,
        "JimboMesh Holler",
        HOLLER_SERVER_NOT_FOUND_MESSAGE,
        "Open GitHub",
        "Close",
        MessageDialogKind::Error,
    )
    .await;

    if open_install {
        let _ = open::that(HOLLER_SERVER_INSTALL_URL);
    }
}

async fn show_setup_error(app: &tauri::AppHandle, title: &str, message: &str) {
    let _ = show_dialog(
        app,
        title,
        message,
        "Close",
        "Dismiss",
        MessageDialogKind::Error,
    )
    .await;
}

fn render_setup_wizard(app: &tauri::AppHandle, wizard: &SetupWizard) {
    let progress = wizard.progress_percent();
    let should_redirect = wizard.detail == SETUP_COMPLETE_MESSAGE;
    let progress_markup = format!(
        "<div class=\"bar\"><div class=\"fill\" style=\"width:{progress}%\"></div></div><div class=\"percent\">{progress}%</div>"
    );
    let redirect_url = if should_redirect {
        let port = *app.state::<crate::AppState>().port.lock().unwrap();
        let env = read_env_file(app).unwrap_or_default();
        Some(admin_url_from_env(port, &env))
    } else {
        None
    };
    let redirect_script = if should_redirect {
        let encoded = redirect_url
            .as_ref()
            .and_then(|url| serde_json::to_string(url).ok())
            .unwrap_or_else(|| "\"http://localhost:1920/admin\"".to_string());
        format!(
            r#"<script>
  setTimeout(() => {{
    try {{
      const targetUrl = {encoded};
      console.log('First-run setup redirecting to', targetUrl, 'from', window.location.href);
      window.location.href = targetUrl;
    }} catch (error) {{
      console.error('First-run setup redirect failed', error);
    }}
  }}, 2000);
</script>"#
        )
    } else {
        String::new()
    };

    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>JimboMesh Holler Setup</title>
<style>
  :root {{
    color-scheme: dark;
    --bg: #0b1120;
    --panel: rgba(15, 23, 42, 0.95);
    --border: rgba(148, 163, 184, 0.18);
    --accent: #14b8a6;
    --text: #e2e8f0;
    --muted: #94a3b8;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    min-height: 100vh;
    font-family: "Segoe UI", system-ui, sans-serif;
    background:
      radial-gradient(circle at top left, rgba(20, 184, 166, 0.18), transparent 28rem),
      radial-gradient(circle at bottom right, rgba(245, 158, 11, 0.12), transparent 24rem),
      var(--bg);
    color: var(--text);
    display: grid;
    place-items: center;
    padding: 24px;
  }}
  .shell {{
    width: min(760px, 100%);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 28px 30px;
    box-shadow: 0 30px 80px rgba(2, 6, 23, 0.55);
  }}
  h1 {{
    margin: 0 0 10px;
    font-size: 28px;
  }}
  p {{
    margin: 0;
    color: var(--muted);
    line-height: 1.55;
  }}
  .steps {{
    margin: 28px 0 22px;
    display: grid;
    gap: 12px;
  }}
  .step {{
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(148, 163, 184, 0.12);
  }}
  .icon {{
    font-size: 24px;
    text-align: center;
  }}
  .label {{
    font-weight: 600;
    letter-spacing: 0.01em;
  }}
  .detail {{
    color: var(--muted);
    white-space: nowrap;
    margin-left: 16px;
  }}
  .bar {{
    height: 14px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.16);
    overflow: hidden;
    margin-top: 10px;
  }}
  .fill {{
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #14b8a6, #f59e0b);
    transition: width 220ms ease;
  }}
  .percent {{
    margin-top: 10px;
    color: var(--muted);
    font-size: 14px;
  }}
</style>
</head>
<body>
  <main class="shell">
    <h1>🥃 JimboMesh Holler — First Run Setup</h1>
    <p>{headline}</p>
    <p style="margin-top:8px">{detail}</p>
    <section class="steps">{steps}</section>
    {progress_markup}
  </main>
  {redirect_script}
</body>
</html>"#,
        headline = html_escape(&wizard.headline),
        detail = html_escape(&wizard.detail),
        steps = render_setup_steps(wizard),
        progress_markup = progress_markup,
        redirect_script = redirect_script
    );

    if let Some(window) = app.get_webview_window("main") {
        if let Ok(encoded) = serde_json::to_string(&html) {
            let _ = window.eval(&format!(
                "document.open();document.write({encoded});document.close();"
            ));
        }
    }
}

fn render_setup_steps(wizard: &SetupWizard) -> String {
    [&wizard.node, &wizard.ollama, &wizard.server, &wizard.model]
        .into_iter()
        .map(render_setup_step)
        .collect::<Vec<_>>()
        .join("")
}

fn render_setup_step(step: &StepDisplay) -> String {
    format!(
        "<div class=\"step\"><div class=\"icon\">{icon}</div><div class=\"label\">{label}</div><div class=\"detail\">{detail}</div></div>",
        icon = step.status_symbol(),
        label = html_escape(step.label),
        detail = html_escape(&step.detail)
    )
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn admin_url_from_env(port: u16, env: &HashMap<String, String>) -> String {
    let key = env
        .get("JIMBOMESH_HOLLER_API_KEY")
        .or_else(|| env.get("ADMIN_API_KEY"))
        .map(|s| s.as_str())
        .unwrap_or("");

    if key.is_empty() {
        eprintln!("[holler-desktop] No API key found \u{2014} navigating without auto-auth");
        format!("http://localhost:{port}/admin")
    } else {
        format!("http://localhost:{port}/admin#key={key}")
    }
}

fn schedule_setup_redirect(app: &tauri::AppHandle, port: u16, env: &HashMap<String, String>) {
    let url = admin_url_from_env(port, env);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        eprintln!(
            "[holler-desktop] Redirecting setup webview to {}",
            if url.contains("#key=") {
                url.split("#key=")
                    .next()
                    .map(|base| format!("{base}#key=<redacted>"))
                    .unwrap_or_else(|| "<unknown>".to_string())
            } else {
                url.clone()
            }
        );
        replace_main_window_with_url(&app, &url);
    });
}

fn navigate_with_key_from(app: &tauri::AppHandle, port: u16, env: &HashMap<String, String>) {
    let url = admin_url_from_env(port, env);
    navigate_with_url(app, &url);
}

fn navigate_with_url(app: &tauri::AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window("main") {
        match url.parse() {
            Ok(parsed) => {
                let _ = w.navigate(parsed);
                eprintln!(
                    "[holler-desktop] Navigated webview to {}",
                    if url.contains("#key=") {
                        url.split("#key=")
                            .next()
                            .map(|base| format!("{base}#key=<redacted>"))
                            .unwrap_or_else(|| "<unknown>".to_string())
                    } else {
                        url.to_string()
                    }
                );
            }
            Err(e) => eprintln!("[holler-desktop] Failed to parse URL: {e}"),
        }
    }
}

fn replace_main_window_with_url(app: &tauri::AppHandle, url: &str) {
    let parsed = match url.parse() {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("[holler-desktop] Failed to parse redirect URL: {e}");
            return;
        }
    };
    let app = app.clone();
    let redacted = if url.contains("#key=") {
        url.split("#key=")
            .next()
            .map(|base| format!("{base}#key=<redacted>"))
            .unwrap_or_else(|| "<unknown>".to_string())
    } else {
        url.to_string()
    };
    let app_for_main_thread = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_main_thread.get_webview_window("admin") {
            let _ = window.show();
            let _ = window.set_focus();
            eprintln!("[holler-desktop] Focused existing admin webview at {redacted}");
            return;
        }

        match WebviewWindowBuilder::new(&app_for_main_thread, "admin", WebviewUrl::External(parsed))
            .title("JimboMesh Holler")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .build()
        {
            Ok(window) => {
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(setup_window) = app_for_main_thread.get_webview_window("main") {
                    let _ = setup_window.destroy();
                }
                eprintln!("[holler-desktop] Opened admin webview at {redacted}");
            }
            Err(e) => eprintln!("[holler-desktop] Failed to open admin webview: {e}"),
        }
    });
}

fn env_candidates(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(paths) = process::runtime_paths(app) {
        candidates.push(paths.env_file);
    }

    if cfg!(debug_assertions) {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo_root) = manifest.parent().and_then(|p| p.parent()) {
            candidates.push(repo_root.join(".env"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join(".env");
        if !candidates.contains(&p) {
            candidates.push(p);
        }
    }

    candidates
}

fn read_env_file(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let candidates = env_candidates(app);

    for path in &candidates {
        if let Ok(contents) = std::fs::read_to_string(path) {
            eprintln!("[holler-desktop] Reading .env from {}", path.display());
            return Ok(parse_env(&contents));
        }
    }

    Err(format!(
        "No .env found in any of: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn parse_env(contents: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    map
}

fn generate_hex_key(bytes: usize) -> String {
    let mut rng = rand::thread_rng();
    let key: Vec<u8> = (0..bytes).map(|_| rng.gen()).collect();
    hex::encode(&key)
}

fn chrono_free_date() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix-{now}")
}
