use std::path::PathBuf;

// Version of the bundled CLI — matches the app release version
const BUNDLED_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn try_install_cli() {
    if let Err(e) = install_cli_inner() {
        log::warn!("observe CLI install skipped (non-fatal): {}", e);
    }
}

fn install_cli_inner() -> Result<(), Box<dyn std::error::Error>> {
    let bundled = bundled_binary_path()?;

    if !bundled.exists() {
        log::info!("observe sidecar not found at {:?}, skipping", bundled);
        return Ok(());
    }

    let (install_dir, bin_name) = install_destination()?;
    let dest = install_dir.join(&bin_name);
    let version_file = install_dir.join(".observe-version");

    // Check if already up to date
    if dest.exists() {
        if let Ok(installed) = std::fs::read_to_string(&version_file) {
            if installed.trim() == BUNDLED_VERSION {
                log::info!("observe CLI is up to date ({})", BUNDLED_VERSION);
                return Ok(());
            }
            log::info!(
                "Updating observe CLI: {} -> {}",
                installed.trim(),
                BUNDLED_VERSION
            );
        }
    } else {
        log::info!(
            "Installing observe CLI {} to {:?}",
            BUNDLED_VERSION,
            dest
        );
    }

    std::fs::create_dir_all(&install_dir)?;
    std::fs::copy(&bundled, &dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    }

    std::fs::write(&version_file, BUNDLED_VERSION)?;

    #[cfg(target_os = "windows")]
    add_to_windows_path(&install_dir)?;

    log::info!("observe CLI installed to {:?}", dest);
    Ok(())
}

fn bundled_binary_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("could not get exe directory")?
        .to_path_buf();

    // Tauri bundles the sidecar without the target triple suffix in the final app
    #[cfg(target_os = "windows")]
    let name = "observe.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "observe";

    Ok(exe_dir.join(name))
}

fn install_destination() -> Result<(PathBuf, String), Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "LOCALAPPDATA not set")?;
        let dir = PathBuf::from(local_app_data)
            .join("Programs")
            .join("Observer");
        Ok((dir, "observe.exe".to_string()))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir().ok_or("could not determine home directory")?;
        Ok((home.join(".local").join("bin"), "observe".to_string()))
    }
}

#[cfg(target_os = "windows")]
fn add_to_windows_path(install_dir: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let install_str = install_dir.to_string_lossy().to_string();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env_key = hkcu.open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)?;

    let current_path: String = env_key.get_value("PATH").unwrap_or_default();

    if current_path.split(';').any(|p| p.trim() == install_str) {
        log::info!("observe CLI dir already in Windows PATH");
        return Ok(());
    }

    let new_path = if current_path.is_empty() {
        install_str
    } else {
        format!("{};{}", current_path, install_str)
    };

    env_key.set_value("PATH", &new_path)?;
    log::info!("Added {:?} to Windows user PATH", install_dir);
    Ok(())
}
