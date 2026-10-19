const COMMANDS: &[&str] = &[
    "start_capture_cmd",
    "stop_capture_cmd",
    "stop_video_cmd",
    "stop_audio_cmd",
    "get_frame_cmd",
    "get_broadcast_status",
    "get_capture_targets_cmd",
    "start_capture_stream_cmd",
    "start_video_stream_cmd",
    "start_audio_stream_cmd",
    // Android channel-based streaming commands
    "stop_video_stream_cmd",
    "stop_audio_stream_cmd",
];

fn main() {
    // On macOS, link against the Swift runtime for screencapturekit
    #[cfg(target_os = "macos")]
    {
        // Add rpath to find Swift runtime libraries
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        // Use Xcode's Swift libraries as fallback
        if let Ok(output) = std::process::Command::new("xcode-select")
            .arg("-p")
            .output()
        {
            if output.status.success() {
                let xcode_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!(
                    "cargo:rustc-link-arg=-Wl,-rpath,{}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
                    xcode_path
                );
            }
        }
    }

    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .android_path("android")
        .build();
}
