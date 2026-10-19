use serde::de::DeserializeOwned;
use tauri::{plugin::{PluginApi, PluginHandle}, AppHandle, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pip);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PiP<R>, Box<dyn std::error::Error>> {
    log::info!("[PiP] Mobile plugin initialized");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_pip)?;
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.plugin.pip", "PipPlugin")?;
    Ok(PiP(handle))
}

pub struct PiP<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> PiP<R> {
    pub fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        log::info!("[PiP] Starting PiP");
        self.0
            .run_mobile_plugin("startPip", ())
            .map_err(Into::into)
    }

    pub fn stop(&self) -> Result<(), Box<dyn std::error::Error>> {
        log::info!("[PiP] Stopping PiP");
        self.0
            .run_mobile_plugin("stopPip", ())
            .map_err(Into::into)
    }
}
