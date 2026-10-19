use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
mod mobile;

/// Initializes the PiP plugin
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("pip")
        .invoke_handler(tauri::generate_handler![
            start_pip_cmd,
            stop_pip_cmd
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                let pip = mobile::init(_app, _api)?;
                _app.manage(pip);
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
async fn start_pip_cmd<R: Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let pip = _app.state::<mobile::PiP<R>>();
        pip.start().map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "ios"))]
    Ok(())
}

#[tauri::command]
async fn stop_pip_cmd<R: Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let pip = _app.state::<mobile::PiP<R>>();
        pip.stop().map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "ios"))]
    Ok(())
}
