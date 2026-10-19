import ReplayKit
import UIKit
import Tauri

@objc public class ScreenCapturePlugin: Plugin {
    private var broadcastPicker: RPSystemBroadcastPickerView?
    private var pickerWindow: UIWindow?
    private let appGroupID = "group.com.observer.ai"

    override init() {
        super.init()
    }

    /// Get the App Group container URL
    private func getAppGroupURL() -> URL? {
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
    }

    /// Get the App Group container path as a string (for passing to Rust)
    @objc public func getAppGroupPath(_ invoke: Invoke) throws {
        if let url = getAppGroupURL() {
            invoke.resolve(url.path)
        } else {
            invoke.reject("Failed to get App Group container URL for \(appGroupID)")
        }
    }

    /// Read the broadcast extension debug log
    @objc public func readBroadcastDebugLog(_ invoke: Invoke) throws {
        guard let containerURL = getAppGroupURL() else {
            invoke.reject("Failed to get App Group container")
            return
        }

        let logURL = containerURL.appendingPathComponent("broadcast_debug.log")

        if FileManager.default.fileExists(atPath: logURL.path) {
            do {
                let content = try String(contentsOf: logURL, encoding: .utf8)
                invoke.resolve(content)
            } catch {
                invoke.reject("Failed to read log: \(error.localizedDescription)")
            }
        } else {
            invoke.resolve("No debug log found at \(logURL.path)")
        }
    }

    /// List all files in the App Group container (for debugging)
    @objc public func listAppGroupFiles(_ invoke: Invoke) throws {
        guard let containerURL = getAppGroupURL() else {
            invoke.reject("Failed to get App Group container")
            return
        }

        do {
            let files = try FileManager.default.contentsOfDirectory(atPath: containerURL.path)
            let result: [String: Any] = [
                "path": containerURL.path,
                "files": files
            ]
            invoke.resolve(result)
        } catch {
            invoke.reject("Failed to list files: \(error.localizedDescription)")
        }
    }

    @objc public func startCapture(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
            picker.preferredExtension = "com.observer.ai.broadcast"
            picker.showsMicrophoneButton = false

            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                let window = UIWindow(windowScene: windowScene)
                window.rootViewController = UIViewController()
                window.windowLevel = .alert + 1
                window.isHidden = false
                window.rootViewController?.view.addSubview(picker)

                self.pickerWindow = window
                self.broadcastPicker = picker

                // Trigger picker button
                for view in picker.subviews {
                    if let button = view as? UIButton {
                        button.sendActions(for: .touchUpInside)
                        break
                    }
                }

                // Auto-hide window after user makes selection (2 seconds delay)
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                    self?.pickerWindow?.isHidden = true
                }
            }

            invoke.resolve(true)
        }
    }

    @objc public func stopCapture(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in
            self?.pickerWindow?.isHidden = true
            self?.pickerWindow = nil
            self?.broadcastPicker = nil
            invoke.resolve()
        }
    }

    @objc public func getFrame(_ invoke: Invoke) throws {
        // Deprecated - use get_broadcast_frame instead
        invoke.reject("Use get_broadcast_frame command instead")
    }

    @objc public func getBroadcastStatus(_ invoke: Invoke) throws {
        // Deprecated - status now comes from Rust server via get_broadcast_status command
        invoke.reject("Use get_broadcast_status Tauri command instead")
    }
}

@_cdecl("init_plugin_screen_capture")
public func initPlugin() -> Plugin {
    return ScreenCapturePlugin()
}
