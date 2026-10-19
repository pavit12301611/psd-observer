// In src-tauri/src/overlay.rs

use crate::{AppState, OverlayMessage, OverlayState};
use axum::{extract::State as AxumState, http::StatusCode, response::Json};
use serde::Deserialize;
use tauri::{Emitter, Manager};

#[derive(Deserialize)]
pub struct OverlayPayload {
    message: String,
}

pub async fn overlay_handler(
    AxumState(state): AxumState<AppState>,
    Json(payload): Json<OverlayPayload>,
) -> StatusCode {
    log::info!("Received overlay request: '{}'", payload.message);

    // Get the overlay state from the app handle
    let overlay_state = state.app_handle.state::<OverlayState>();

    // Create a new overlay message
    let overlay_message = OverlayMessage {
        id: uuid::Uuid::new_v4().to_string(),
        content: payload.message,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };

    // Add the message to the overlay state
    overlay_state.messages.lock().unwrap().push(overlay_message);

    // Emit event to notify frontend of message update
    let messages = overlay_state.messages.lock().unwrap().clone();
    if let Err(e) = state.app_handle.emit("overlay-messages-updated", &messages) {
        log::warn!("Failed to emit overlay-messages-updated event: {}", e);
    } else {
        log::debug!(
            "Emitted overlay-messages-updated event with {} messages",
            messages.len()
        );
    }

    StatusCode::OK
}
