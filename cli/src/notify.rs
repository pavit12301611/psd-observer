use crate::runner::CommandResult;
use serde::Serialize;

// Discord payload types
#[derive(Serialize)]
struct DiscordEmbed {
    title: String,
    color: u32,
    description: String,
}

#[derive(Serialize)]
struct DiscordPayload {
    username: String,
    avatar_url: String,
    embeds: Vec<DiscordEmbed>,
}

// API payload types
#[derive(Serialize)]
struct TelegramPayload {
    chat_id: String,
    message: String,
}

#[derive(Serialize)]
struct SmsPayload {
    to_number: String,
    message: String,
}

#[derive(Serialize)]
struct WhatsAppPayload {
    to_number: String,
    message: String,
}

#[derive(Serialize)]
struct CallPayload {
    to_number: String,
    message: String,
}

#[derive(Serialize)]
struct EmailPayload {
    to_email: String,
    message: String,
}

/// Send a Discord notification about command completion
pub async fn send_discord_notification(
    webhook_url: &str,
    command: &str,
    result: &CommandResult,
) -> Result<(), Box<dyn std::error::Error>> {
    let exit_code = result.exit_code.unwrap_or(-1);
    let duration = result.format_duration();

    // Green for success, red for failure
    let color = if result.success { 0x2ECC71 } else { 0xE74C3C };
    let status = if result.success { "Completed" } else { "Failed" };

    let description = format!(
        "```{}```\nExit: {} | Duration: {}",
        command, exit_code, duration
    );

    let payload = DiscordPayload {
        username: "Observer CLI".to_string(),
        avatar_url: "https://raw.githubusercontent.com/Roy3838/Observer/dev/app/public/logo.png"
            .to_string(),
        embeds: vec![DiscordEmbed {
            title: format!("Command {}", status),
            color,
            description,
        }],
    };

    let client = reqwest::Client::new();
    let response = client.post(webhook_url).json(&payload).send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Discord webhook failed: {} - {}", status, text).into());
    }

    Ok(())
}

/// Send a Telegram notification via Observer API
pub async fn send_telegram_notification(
    chat_id: &str,
    command: &str,
    result: &CommandResult,
    access_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let exit_code = result.exit_code.unwrap_or(-1);
    let duration = result.format_duration();

    let status_emoji = if result.success { "✅" } else { "❌" };
    let message = format!(
        "{} *Command {}*\n`{}`\nExit: {} | Duration: {}",
        status_emoji,
        if result.success { "Completed" } else { "Failed" },
        command,
        exit_code,
        duration
    );

    let payload = TelegramPayload {
        chat_id: chat_id.to_string(),
        message,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.observer-ai.com/tools/send-telegram")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Telegram API failed: {} - {}", status, text).into());
    }

    Ok(())
}

/// Send an SMS notification via Observer API
pub async fn send_sms_notification(
    phone_number: &str,
    command: &str,
    result: &CommandResult,
    access_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let exit_code = result.exit_code.unwrap_or(-1);
    let duration = result.format_duration();

    let status = if result.success { "Completed" } else { "Failed" };
    let message = format!(
        "Command {}: {}\nExit: {} | Duration: {}",
        status, command, exit_code, duration
    );

    let payload = SmsPayload {
        to_number: phone_number.to_string(),
        message,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.observer-ai.com/tools/send-sms")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("SMS API failed: {} - {}", status, text).into());
    }

    Ok(())
}

/// Send a WhatsApp notification via Observer API
pub async fn send_whatsapp_notification(
    phone_number: &str,
    command: &str,
    result: &CommandResult,
    access_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let exit_code = result.exit_code.unwrap_or(-1);
    let duration = result.format_duration();

    let status_emoji = if result.success { "✅" } else { "❌" };
    let message = format!(
        "{} *Command {}*\n`{}`\nExit: {} | Duration: {}",
        status_emoji,
        if result.success { "Completed" } else { "Failed" },
        command,
        exit_code,
        duration
    );

    let payload = WhatsAppPayload {
        to_number: phone_number.to_string(),
        message,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.observer-ai.com/tools/send-whatsapp")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("WhatsApp API failed: {} - {}", status, text).into());
    }

    Ok(())
}

/// Make a voice call notification via Observer API
pub async fn send_call_notification(
    phone_number: &str,
    command: &str,
    result: &CommandResult,
    access_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let exit_code = result.exit_code.unwrap_or(-1);
    let duration = result.format_duration();

    let status = if result.success { "completed successfully" } else { "failed" };
    let message = format!(
        "Your command {} {}. Exit code: {}. Duration: {}.",
        command, status, exit_code, duration
    );

    let payload = CallPayload {
        to_number: phone_number.to_string(),
        message,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.observer-ai.com/tools/make-call")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Call API failed: {} - {}", status, text).into());
    }

    Ok(())
}

/// Send an email notification via Observer API
pub async fn send_email_notification(
    email_address: &str,
    command: &str,
    result: &CommandResult,
    access_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let exit_code = result.exit_code.unwrap_or(-1);
    let duration = result.format_duration();

    let status = if result.success { "Completed" } else { "Failed" };
    let message = format!(
        "Command {}: {}\n\nExit code: {}\nDuration: {}",
        status, command, exit_code, duration
    );

    let payload = EmailPayload {
        to_email: email_address.to_string(),
        message,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.observer-ai.com/tools/send-email")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Email API failed: {} - {}", status, text).into());
    }

    Ok(())
}
