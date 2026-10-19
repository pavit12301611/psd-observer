// In src-tauri/src/controls.rs

use crate::AppState;
use axum::{extract::State as AxumState, http::StatusCode, Json};
use serde::Deserialize;

// Desktop-only implementation using Enigo
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use enigo::{Button, Enigo, Mouse, Settings};

#[derive(Deserialize, Default)]
pub struct ClickRequest {
    #[serde(default = "default_button")]
    button: String,
}

fn default_button() -> String {
    "left".to_string()
}

/// Handler for /click endpoint
/// Triggers a mouse click at the current cursor position (desktop only)
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn click_handler(
    AxumState(_state): AxumState<AppState>,
    Json(payload): Json<Option<ClickRequest>>,
) -> StatusCode {
    let button_type = payload
        .map(|p| p.button)
        .unwrap_or_else(|| "left".to_string());

    log::info!("Received click request: {}", button_type);

    let button = match button_type.to_lowercase().as_str() {
        "right" => Button::Right,
        _ => Button::Left,
    };

    match Enigo::new(&Settings::default()) {
        Ok(mut enigo) => match enigo.button(button, enigo::Direction::Click) {
            Ok(_) => {
                log::info!("Mouse {} click executed successfully", button_type);
                StatusCode::OK
            }
            Err(e) => {
                log::error!("Failed to execute mouse click: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            }
        },
        Err(e) => {
            log::error!("Failed to initialize Enigo: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// Mobile stub for click handler - not supported on mobile
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn click_handler(
    AxumState(_state): AxumState<AppState>,
    Json(_payload): Json<Option<ClickRequest>>,
) -> StatusCode {
    log::warn!("Mouse control not available on mobile");
    StatusCode::NOT_IMPLEMENTED
}
