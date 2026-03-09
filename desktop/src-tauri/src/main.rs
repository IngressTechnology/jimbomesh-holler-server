#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod process;
mod setup;

use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};

pub struct AppState {
    pub holler_process: Mutex<Option<tokio::process::Child>>,
    pub ollama_process: Mutex<Option<tokio::process::Child>>,
    pub server_ready: Mutex<bool>,
    pub port: Mutex<u16>,
    /// true when Tauri started the server itself (standalone mode);
    /// false when it attached to an existing server (attach mode).
    pub managed: Mutex<bool>,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            holler_process: Mutex::new(None),
            ollama_process: Mutex::new(None),
            server_ready: Mutex::new(false),
            port: Mutex::new(1920),
            managed: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            cmd_server_status,
            cmd_get_port,
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = setup::launch_services(&handle).await {
                    eprintln!("Failed to launch services: {e}");
                }
                update_tray_menu(&handle);
                start_health_polling(handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            label,
            ..
        } => {
            api.prevent_close();
            if let Some(w) = app_handle.get_webview_window(&label) {
                let _ = w.hide();
            }
        }
        RunEvent::ExitRequested { api, .. } => {
            let _ = api;
        }
        RunEvent::Exit => {
            process::kill_children(app_handle);
        }
        _ => {}
    });
}

// ── Tray ──────────────────────────────────────────────────────────

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = make_tray_menu(app, "Starting\u{2026}", 1920, false)?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("JimboMesh Holler")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_tray_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                if let Some(w) = primary_window(tray.app_handle()) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder.build(app)?;
    Ok(())
}

fn make_tray_menu(
    app: &tauri::AppHandle,
    status_text: &str,
    port: u16,
    managed: bool,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let status_label = format!("\u{25cf} {status_text}");
    let port_label = format!("    Port: {port}");

    let status = MenuItem::with_id(app, "status", &status_label, false, None::<&str>)?;
    let port_item = MenuItem::with_id(app, "port", &port_label, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "\u{25a3}  Show Window", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "\u{2014}  Hide Window", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let start = MenuItem::with_id(app, "start_server", "\u{25b6}  Start Server", managed, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop_server", "\u{25a0}  Stop Server", managed, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart_server", "\u{21bb}  Restart Server", managed, None::<&str>)?;

    let sep3 = PredefinedMenuItem::separator(app)?;
    let portal = MenuItem::with_id(app, "open_portal", "\u{2295}  Open JimboMesh Portal", true, None::<&str>)?;
    let switch = MenuItem::with_id(app, "switch_mode", "\u{2699}  Switch Mode\u{2026}", true, None::<&str>)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "\u{2715}  Quit JimboMesh", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&status)
        .item(&port_item)
        .item(&sep1)
        .item(&show)
        .item(&hide)
        .item(&sep2)
        .item(&start)
        .item(&stop)
        .item(&restart)
        .item(&sep3)
        .item(&portal)
        .item(&switch)
        .item(&sep4)
        .item(&quit)
        .build()
}

fn handle_tray_event(app: &tauri::AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(w) = primary_window(app) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "hide" => {
            if let Some(w) = primary_window(app) {
                let _ = w.hide();
            }
        }
        "start_server" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let port = *handle.state::<AppState>().port.lock().unwrap();
                if let Err(e) = process::start_holler(&handle, port).await {
                    eprintln!("[holler-desktop] Start failed: {e}");
                }
                update_tray_menu(&handle);
            });
        }
        "stop_server" => {
            process::stop_holler(app);
            update_tray_menu(app);
        }
        "restart_server" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                process::stop_holler(&handle);
                tokio::time::sleep(Duration::from_secs(1)).await;
                let port = *handle.state::<AppState>().port.lock().unwrap();
                if let Err(e) = process::start_holler(&handle, port).await {
                    eprintln!("[holler-desktop] Restart failed: {e}");
                }
                update_tray_menu(&handle);
            });
        }
        "open_portal" => {
            let _ = open::that("https://app.jimbomesh.ai");
        }
        "switch_mode" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = setup::switch_mode(&handle).await {
                    eprintln!("[holler-desktop] Switch mode failed: {e}");
                }
                update_tray_menu(&handle);
            });
        }
        "quit" => {
            process::kill_children(app);
            app.exit(0);
        }
        _ => {}
    }
}

fn primary_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow<tauri::Wry>> {
    app.get_webview_window("admin")
        .or_else(|| app.get_webview_window("main"))
}

/// Rebuild the tray menu with current state.
pub fn update_tray_menu(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let ready = *state.server_ready.lock().unwrap();
    let port = *state.port.lock().unwrap();
    let managed = *state.managed.lock().unwrap();

    let status_text = if ready {
        format!("Running (port {port})")
    } else if managed {
        "Stopped".to_string()
    } else {
        "Starting\u{2026}".to_string()
    };

    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = make_tray_menu(app, &status_text, port, managed) {
            let _ = tray.set_menu(Some(menu));
        }
        let tooltip = if ready {
            format!("JimboMesh Holler \u{2014} port {port}")
        } else {
            "JimboMesh Holler \u{2014} stopped".to_string()
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

/// Poll the health endpoint every 30s and update the tray if status changes.
fn start_health_polling(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();

        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            let port = *app.state::<AppState>().port.lock().unwrap();
            let url = format!("http://127.0.0.1:{port}/health");

            let healthy = client
                .get(&url)
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);

            let prev = {
                let state = app.state::<AppState>();
                let prev = *state.server_ready.lock().unwrap();
                *state.server_ready.lock().unwrap() = healthy;
                prev
            };

            if healthy != prev {
                eprintln!(
                    "[holler-desktop] Health status changed: {}",
                    if healthy { "UP" } else { "DOWN" }
                );
                update_tray_menu(&app);
            }
        }
    });
}

// ── Tauri commands exposed to the webview ────────────────────────

#[tauri::command]
fn cmd_server_status(state: tauri::State<'_, AppState>) -> bool {
    *state.server_ready.lock().unwrap()
}

#[tauri::command]
fn cmd_get_port(state: tauri::State<'_, AppState>) -> u16 {
    *state.port.lock().unwrap()
}
