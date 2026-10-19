fn main() {
    tauri_build::build();

    // Platform-specific build steps
    #[cfg(target_os = "android")]
    {
        println!("cargo:rustc-link-lib=dylib=c++");
    }

    #[cfg(target_os = "ios")]
    {
        // Link ReplayKit framework for screen recording (when plugin is ready)
        // println!("cargo:rustc-link-lib=framework=ReplayKit");
    }

    // On macOS, link against Swift runtime for screencapturekit
    #[cfg(target_os = "macos")]
    {
        // Add rpath to find Swift runtime libraries in system location
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        // Also use Xcode's Swift libraries path as fallback
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
}
