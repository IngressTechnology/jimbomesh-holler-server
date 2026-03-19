use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopConfig {
    #[serde(default)]
    pub mode: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default, rename = "lastUsed")]
    pub last_used: String,
    #[serde(default, rename = "setupComplete")]
    pub setup_complete: bool,
}

fn default_port() -> u16 {
    1920
}

pub fn load(app: &tauri::AppHandle) -> Option<DesktopConfig> {
    let path = config_path(app).ok()?;
    let contents = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn save(app: &tauri::AppHandle, cfg: &DesktopConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Cannot write config.json: {e}"))
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("config.json"))
        .map_err(|e| format!("Cannot resolve config path: {e}"))
}
