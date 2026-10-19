use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Auth0 configuration - Native app with Device Code grant
const AUTH0_DOMAIN: &str = "auth.observer-ai.com";
const AUTH0_CLIENT_ID: &str = "rAGRyYmXOpWVh35GI9A5ij7vE7BOq8f0";
const AUTH0_AUDIENCE: &str = "https://api.observer-ai.com";

/// Stored authentication tokens
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: u64, // Unix timestamp
}

/// Device code response from Auth0
#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

/// Token response from Auth0
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    error: Option<String>,
}

/// Error response from Auth0 during polling
#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: String,
    error_description: Option<String>,
}

impl AuthTokens {
    /// Get the auth file path (~/.config/observe/auth.json)
    fn auth_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("observe").join("auth.json"))
    }

    /// Load tokens from file
    pub fn load() -> Option<Self> {
        let path = Self::auth_path()?;
        let contents = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&contents).ok()
    }

    /// Save tokens to file
    pub fn save(&self) -> io::Result<()> {
        let Some(path) = Self::auth_path() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine config directory",
            ));
        };

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        fs::write(path, contents)
    }

    /// Delete stored tokens
    pub fn delete() -> io::Result<()> {
        if let Some(path) = Self::auth_path() {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    /// Check if tokens are expired
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        now >= self.expires_at
    }

    /// Get valid access token, refreshing if needed
    pub async fn get_valid_token(&mut self) -> Result<String, Box<dyn std::error::Error>> {
        // If not expired, return current token
        if !self.is_expired() {
            return Ok(self.access_token.clone());
        }

        // Try to refresh
        if let Some(ref refresh_token) = self.refresh_token {
            match refresh_tokens(refresh_token).await {
                Ok(new_tokens) => {
                    *self = new_tokens;
                    self.save()?;
                    return Ok(self.access_token.clone());
                }
                Err(e) => {
                    eprintln!("Token refresh failed: {}. Please run 'observe login' again.", e);
                }
            }
        }

        Err("Token expired. Please run 'observe login'.".into())
    }
}

/// Start the device code login flow
pub async fn login() -> Result<AuthTokens, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();

    // Step 1: Request device code
    eprintln!("Requesting device code...");

    let device_code_url = format!("https://{}/oauth/device/code", AUTH0_DOMAIN);
    let response = client
        .post(&device_code_url)
        .form(&[
            ("client_id", AUTH0_CLIENT_ID),
            ("scope", "openid profile email offline_access"),
            ("audience", AUTH0_AUDIENCE),
        ])
        .send()
        .await?;

    if !response.status().is_success() {
        let text = response.text().await?;
        return Err(format!("Failed to get device code: {}", text).into());
    }

    let device_code: DeviceCodeResponse = response.json().await?;

    // Step 2: Display login instructions to stderr
    eprintln!();
    eprintln!("To login, open this URL in your browser:");
    eprintln!();
    eprintln!("  {}", device_code.verification_uri_complete);
    eprintln!();
    eprintln!("Or go to {} and enter code: {}", device_code.verification_uri, device_code.user_code);
    eprintln!();
    eprint!("Waiting for login...");
    io::stderr().flush()?;

    // Step 3: Poll for token
    let token_url = format!("https://{}/oauth/token", AUTH0_DOMAIN);
    let poll_interval = Duration::from_secs(device_code.interval.max(5)); // At least 5 seconds
    let deadline = std::time::Instant::now() + Duration::from_secs(device_code.expires_in);

    loop {
        if std::time::Instant::now() > deadline {
            eprintln!();
            return Err("Login timed out. Please try again.".into());
        }

        tokio::time::sleep(poll_interval).await;
        eprint!(".");
        io::stderr().flush()?;

        let response = client
            .post(&token_url)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", &device_code.device_code),
                ("client_id", AUTH0_CLIENT_ID),
            ])
            .send()
            .await?;

        let status = response.status();
        let text = response.text().await?;

        if status.is_success() {
            // Success! Parse tokens
            let token_response: TokenResponse = serde_json::from_str(&text)?;

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();

            let tokens = AuthTokens {
                access_token: token_response.access_token,
                refresh_token: token_response.refresh_token,
                expires_at: now + token_response.expires_in,
            };

            tokens.save()?;

            eprintln!();
            eprintln!("Login successful!");
            return Ok(tokens);
        }

        // Check error type
        if let Ok(error) = serde_json::from_str::<ErrorResponse>(&text) {
            match error.error.as_str() {
                "authorization_pending" => {
                    // User hasn't completed login yet, keep polling
                    continue;
                }
                "slow_down" => {
                    // We're polling too fast, wait longer
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                "expired_token" => {
                    eprintln!();
                    return Err("Device code expired. Please try again.".into());
                }
                "access_denied" => {
                    eprintln!();
                    return Err("Login was denied.".into());
                }
                _ => {
                    eprintln!();
                    return Err(format!(
                        "Login failed: {} - {}",
                        error.error,
                        error.error_description.unwrap_or_default()
                    )
                    .into());
                }
            }
        }
    }
}

/// Refresh tokens using refresh_token
async fn refresh_tokens(refresh_token: &str) -> Result<AuthTokens, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let token_url = format!("https://{}/oauth/token", AUTH0_DOMAIN);

    let response = client
        .post(&token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", AUTH0_CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await?;

    if !response.status().is_success() {
        let text = response.text().await?;
        return Err(format!("Token refresh failed: {}", text).into());
    }

    let token_response: TokenResponse = response.json().await?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    Ok(AuthTokens {
        access_token: token_response.access_token,
        refresh_token: token_response.refresh_token.or(Some(refresh_token.to_string())),
        expires_at: now + token_response.expires_in,
    })
}

/// Logout - delete stored tokens
pub fn logout() -> io::Result<()> {
    AuthTokens::delete()?;
    eprintln!("Logged out successfully.");
    Ok(())
}

/// Show current auth status
pub fn whoami() {
    match AuthTokens::load() {
        Some(tokens) => {
            if tokens.is_expired() {
                eprintln!("Logged in (token expired, will refresh on next use)");
            } else {
                eprintln!("Logged in");
            }
        }
        None => {
            eprintln!("Not logged in. Run 'observe login' to authenticate.");
        }
    }
}
