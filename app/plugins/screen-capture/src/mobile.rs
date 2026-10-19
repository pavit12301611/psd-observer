use serde::{de::DeserializeOwned, Deserialize};
use tauri::{plugin::{PluginApi, PluginHandle}, AppHandle, Runtime};
use crate::error::Result;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_screen_capture);

/// Response from Android plugin (returns {value: bool})
#[derive(Deserialize)]
#[allow(dead_code)]
struct AndroidBoolResponse {
    value: Option<bool>,
}

// Initialize the mobile plugin and return a handle
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<ScreenCapture<R>> {
    log::info!("[ScreenCapture] Mobile plugin initialized");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_screen_capture)?;
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.plugin.screencapture", "ScreenCapturePlugin")?;
    Ok(ScreenCapture(handle))
}

/// Access to the screen capture APIs
pub struct ScreenCapture<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ScreenCapture<R> {
    pub fn start_capture(&self) -> Result<bool> {
        log::info!("[ScreenCapture] Calling native startCapture");

        #[cfg(target_os = "ios")]
        {
            // iOS returns raw bool
            self.0
                .run_mobile_plugin("startCapture", ())
                .map_err(Into::into)
        }

        #[cfg(target_os = "android")]
        {
            // Android returns {value: bool}
            let response: AndroidBoolResponse = self.0
                .run_mobile_plugin("startCapture", ())
                .map_err(|e| {
                    log::error!("[ScreenCapture] Android plugin error: {:?}", e);
                    e
                })?;
            Ok(response.value.unwrap_or(false))
        }
    }

    pub fn stop_capture(&self) -> Result<()> {
        log::info!("[ScreenCapture] Calling native stopCapture");
        self.0
            .run_mobile_plugin("stopCapture", ())
            .map_err(Into::into)
    }

    pub fn get_frame(&self) -> Result<String> {
        log::debug!("[ScreenCapture] Calling native getFrame");
        self.0
            .run_mobile_plugin("getFrame", ())
            .map_err(Into::into)
    }

    /// Get the App Group container path (iOS only)
    pub fn get_app_group_path(&self) -> Result<String> {
        log::info!("[ScreenCapture] Getting App Group path");
        self.0
            .run_mobile_plugin("getAppGroupPath", ())
            .map_err(Into::into)
    }

    /// Read the broadcast extension debug log (iOS only)
    pub fn read_broadcast_debug_log(&self) -> Result<String> {
        log::info!("[ScreenCapture] Reading broadcast debug log");
        self.0
            .run_mobile_plugin("readBroadcastDebugLog", ())
            .map_err(Into::into)
    }

    /// List files in the App Group container (iOS only, for debugging)
    pub fn list_app_group_files(&self) -> Result<serde_json::Value> {
        log::info!("[ScreenCapture] Listing App Group files");
        self.0
            .run_mobile_plugin("listAppGroupFiles", ())
            .map_err(Into::into)
    }

    // ==================== Android channel-based streaming ====================

    /// Start video streaming (Android only)
    /// This triggers MediaProjection capture with JNI callbacks
    #[cfg(target_os = "android")]
    pub fn start_video_stream(&self) -> Result<()> {
        log::info!("[ScreenCapture] Starting Android video stream");
        self.0
            .run_mobile_plugin("startVideoStream", ())
            .map_err(Into::into)
    }

    /// Start audio streaming (Android only)
    /// This triggers AudioPlaybackCapture with JNI callbacks
    #[cfg(target_os = "android")]
    pub fn start_audio_stream(&self) -> Result<()> {
        log::info!("[ScreenCapture] Starting Android audio stream");
        self.0
            .run_mobile_plugin("startAudioStream", ())
            .map_err(Into::into)
    }

    /// Stop video streaming (Android only)
    #[cfg(target_os = "android")]
    pub fn stop_video_stream(&self) -> Result<()> {
        log::info!("[ScreenCapture] Stopping Android video stream");
        self.0
            .run_mobile_plugin("stopVideoStream", ())
            .map_err(Into::into)
    }

    /// Stop audio streaming (Android only)
    #[cfg(target_os = "android")]
    pub fn stop_audio_stream(&self) -> Result<()> {
        log::info!("[ScreenCapture] Stopping Android audio stream");
        self.0
            .run_mobile_plugin("stopAudioStream", ())
            .map_err(Into::into)
    }
}
