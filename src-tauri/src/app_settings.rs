use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Preferences that control the desktop application itself, separate from
/// audio/preset state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Start AudioManager when the current Windows user signs in. New installs
    /// opt in by default; an explicit off choice is persisted.
    #[serde(default = "default_launch_at_login")]
    pub launch_at_login: bool,
}

fn default_launch_at_login() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launch_at_login: default_launch_at_login(),
        }
    }
}

impl AppSettings {
    fn settings_file(app_local_data: &Path) -> PathBuf {
        app_local_data.join("app_settings.json")
    }

    pub fn load_or_default(app_local_data: &Path) -> Self {
        std::fs::read_to_string(Self::settings_file(app_local_data))
            .ok()
            .and_then(|raw| serde_json::from_str::<Self>(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app_local_data: &Path) -> Result<(), String> {
        let path = Self::settings_file(app_local_data);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("create settings dir '{}': {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("serialize app settings: {e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("write '{}': {e}", path.display()))
    }
}

#[cfg(windows)]
pub fn sync_windows_autostart(enabled: bool) -> Result<(), String> {
    use std::io::ErrorKind;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE_NAME: &str = "AudioManager";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu
        .create_subkey_with_flags(RUN_KEY, KEY_WRITE)
        .map_err(|e| format!("open Windows startup settings: {e}"))?;

    if enabled {
        let executable =
            std::env::current_exe().map_err(|e| format!("resolve AudioManager executable: {e}"))?;
        let command = format!("\"{}\"", executable.display());
        run.set_value(VALUE_NAME, &command)
            .map_err(|e| format!("enable Windows startup: {e}"))
    } else {
        match run.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("disable Windows startup: {e}")),
        }
    }
}

#[cfg(not(windows))]
pub fn sync_windows_autostart(_enabled: bool) -> Result<(), String> {
    Err("Windows startup is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn launch_at_login_defaults_to_enabled() {
        assert!(AppSettings::default().launch_at_login);
    }
}
