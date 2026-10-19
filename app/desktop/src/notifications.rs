// In src-tauri/src/notifications.rs

use axum::{extract::State as AxumState, http::StatusCode, response::Json};
use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
// ---- NEW IMPORT ----
use crate::AppState;
use tauri_plugin_notification::NotificationExt;

// --- STRUCTS FOR /ask ---
#[derive(Deserialize)]
pub struct AskPayload {
    title: String,
    question: String,
}

#[derive(Serialize)]
pub struct AskResponse {
    answer: bool,
}

// --- STRUCTS FOR /message ---
#[derive(Deserialize)]
pub struct MessagePayload {
    title: String,
    message: String,
}

// --- STRUCTS FOR /notification ---
#[derive(Deserialize)]
pub struct NotificationPayload {
    title: String,
    body: String,
}

// --- HANDLER for /ask (no changes) ---
pub async fn ask_handler(
    AxumState(state): AxumState<AppState>,
    Json(payload): Json<AskPayload>,
) -> Result<Json<AskResponse>, StatusCode> {
    log::info!("V2: Received ask request: '{}'", payload.question);

    let answer = tokio::task::spawn_blocking(move || {
        state
            .app_handle
            .dialog()
            .message(&payload.question)
            .title(&payload.title)
            .buttons(MessageDialogButtons::YesNo)
            .kind(MessageDialogKind::Info)
            .blocking_show()
    })
    .await
    .unwrap_or(false);

    log::info!("V2: User answered with: {}", answer);
    Ok(Json(AskResponse { answer }))
}

// ---- NEW HANDLER for /message ----
pub async fn message_handler(
    AxumState(state): AxumState<AppState>,
    Json(payload): Json<MessagePayload>,
) -> StatusCode {
    log::info!("V2: Received message request: '{}'", payload.message);

    // We still use spawn_blocking because .blocking_show() waits for user input ("Ok")
    let _ = tokio::task::spawn_blocking(move || {
        state
            .app_handle
            .dialog()
            .message(&payload.message)
            .title(&payload.title)
            .buttons(MessageDialogButtons::Ok) // The only button is "Ok"
            .kind(MessageDialogKind::Info)
            .blocking_show();
    })
    .await;

    log::info!("V2: Message dialog shown and acknowledged by user.");
    StatusCode::OK
}

// ---- NEW HANDLER for /notification ----
pub async fn notification_handler(
    AxumState(state): AxumState<AppState>,
    Json(payload): Json<NotificationPayload>,
) -> StatusCode {
    log::info!(
        "V2: Received system notification request: '{}'",
        payload.body
    );

    // The .show() method for notifications is NON-BLOCKING.
    // It returns immediately, so we do NOT need spawn_blocking here.
    let builder = state
        .app_handle
        .notification()
        .builder()
        .title(payload.title)
        .body(payload.body);

    // Fire and forget the notification.
    if let Err(e) = builder.show() {
        log::error!("Failed to show notification: {}", e);
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

    log::info!("V2: System notification sent successfully.");
    StatusCode::OK
}
