const COMMANDS: &[&str] = &["start_pip_cmd", "stop_pip_cmd"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
