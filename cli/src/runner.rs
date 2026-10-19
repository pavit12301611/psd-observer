use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Result of running a command
pub struct CommandResult {
    pub exit_code: Option<i32>,
    pub duration: Duration,
    pub success: bool,
}

impl CommandResult {
    /// Format duration as human-readable string
    pub fn format_duration(&self) -> String {
        let secs = self.duration.as_secs();

        if secs < 60 {
            format!("{}s", secs)
        } else if secs < 3600 {
            let mins = secs / 60;
            let remaining_secs = secs % 60;
            format!("{}m {}s", mins, remaining_secs)
        } else {
            let hours = secs / 3600;
            let mins = (secs % 3600) / 60;
            format!("{}h {}m", hours, mins)
        }
    }
}

/// Run a command with inherited stdio and return the result
pub fn run_command(args: &[String]) -> std::io::Result<CommandResult> {
    if args.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "No command provided",
        ));
    }

    let start = Instant::now();

    // First arg is the program, rest are arguments
    let mut cmd = Command::new(&args[0]);
    if args.len() > 1 {
        cmd.args(&args[1..]);
    }

    // Inherit stdio so the command behaves normally
    cmd.stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    // Run and wait
    let status: ExitStatus = cmd.spawn()?.wait()?;

    let duration = start.elapsed();

    Ok(CommandResult {
        exit_code: status.code(),
        duration,
        success: status.success(),
    })
}
