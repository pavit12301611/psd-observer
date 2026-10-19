// In src-tauri/src/commands.rs

use crate::{AppState, CommandMessage, CommandState};
use axum::{
    extract::State as AxumState,
    http::StatusCode,
    response::{sse::Event, Json, Sse},
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Manager;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

#[derive(Serialize, Deserialize)]
pub struct CommandsResponse {
    commands: HashMap<String, String>,
}

#[derive(Deserialize)]
pub struct CommandsRequest {
    completed: Vec<String>,
}

/// GET /commands - Returns pending commands and clears completed ones
pub async fn get_commands_handler(
    AxumState(state): AxumState<AppState>,
) -> Result<Json<CommandsResponse>, StatusCode> {
    log::info!("GET /commands - fetching pending commands");

    let command_state = state.app_handle.state::<CommandState>();
    let commands = command_state.pending_commands.lock().unwrap().clone();

    log::info!("Returning {} pending commands", commands.len());

    Ok(Json(CommandsResponse { commands }))
}

/// POST /commands - Marks commands as completed (removes them from pending state)
pub async fn post_commands_handler(
    AxumState(state): AxumState<AppState>,
    Json(payload): Json<CommandsRequest>,
) -> StatusCode {
    log::info!(
        "POST /commands - marking {} commands as completed",
        payload.completed.len()
    );

    let command_state = state.app_handle.state::<CommandState>();
    let mut commands = command_state.pending_commands.lock().unwrap();

    for agent_id in payload.completed {
        commands.remove(&agent_id);
        log::info!("Removed completed command for agent: {}", agent_id);
    }

    StatusCode::OK
}

/// SSE endpoint for real-time command streaming
pub async fn commands_stream_handler(
    AxumState(state): AxumState<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Box<dyn std::error::Error + Send + Sync>>>> {
    log::info!("New SSE client connected to commands stream");

    let command_state = state.app_handle.state::<CommandState>();
    let rx = command_state.command_broadcaster.subscribe();

    let stream = BroadcastStream::new(rx).map(|result| match result {
        Ok(command_msg) => {
            log::debug!("Broadcasting command via SSE: {:?}", command_msg);
            match serde_json::to_string(&command_msg) {
                Ok(json) => Ok(Event::default().data(json)),
                Err(e) => {
                    log::error!("Failed to serialize command message: {}", e);
                    Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
                }
            }
        }
        Err(e) => {
            log::warn!("SSE broadcast error: {}", e);
            Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
        }
    });

    Sse::new(stream)
}

/// Internal function to broadcast a command via SSE (called by shortcut system)
pub fn broadcast_command(command_state: &CommandState, agent_id: String, action: String) {
    log::info!("Broadcasting {} command for agent '{}'", action, agent_id);

    let command_msg = CommandMessage {
        message_type: "command".to_string(),
        agent_id,
        action,
    };

    if let Err(e) = command_state.command_broadcaster.send(command_msg) {
        log::warn!("Failed to broadcast command (no active SSE clients): {}", e);
    }
}
