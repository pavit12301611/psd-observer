import ReplayKit

class BroadcastSetupViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        // Auto-start broadcast immediately (no UI needed)
        // If you want to show UI later, remove this and add buttons
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.userDidFinishSetup()
        }
    }

    func userDidFinishSetup() {
        // Dummy URL - not actually used for local recording
        let broadcastURL = URL(string: "http://localhost:8080")

        // Optional setup info to pass to broadcast extension
        let setupInfo: [String : NSCoding & NSObjectProtocol] = [:]

        // Tell ReplayKit to start the broadcast extension
        self.extensionContext?.completeRequest(withBroadcast: broadcastURL!, setupInfo: setupInfo)
    }

    func userDidCancelSetup() {
        let error = NSError(domain: "com.observer.ai", code: -1, userInfo: nil)
        self.extensionContext?.cancelRequest(withError: error)
    }
}
