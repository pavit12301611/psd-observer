import ReplayKit
import CoreImage
import CoreGraphics
import ImageIO

@objc(SampleHandler)
class SampleHandler: RPBroadcastSampleHandler {

    private let serverURL = URL(string: "http://127.0.0.1:3838/frames")!
    private let baseURL = "http://127.0.0.1:3838"
    private let session: URLSession

    // Reuse CIContext - creating it per-frame causes memory spikes that crash the extension
    private lazy var ciContext: CIContext = {
        CIContext(options: [
            .useSoftwareRenderer: false,  // Use GPU
            .cacheIntermediates: false    // Don't cache to save memory
        ])
    }()

    override init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2.0
        config.urlCache = nil  // Don't cache responses
        self.session = URLSession(configuration: config)
        super.init()
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        NSLog("Broadcast started")
        // Notify server of broadcast start
        Task { await notifyServer(event: "start") }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        guard let imageData = pixelBufferToData(pixelBuffer) else { return }

        // Fire and forget - don't track failures to avoid complexity
        Task {
            var request = URLRequest(url: serverURL)
            request.httpMethod = "POST"
            request.httpBody = imageData
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            _ = try? await session.data(for: request)
        }
    }

    private func pixelBufferToData(_ pixelBuffer: CVPixelBuffer) -> Data? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)

        // Use reused context instead of creating new one each frame
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
            return nil
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.6,  // Lower quality = less memory
        ]

        CGImageDestinationAddImage(destination, cgImage, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }

        return data as Data
    }

    override func broadcastFinished() {
        NSLog("Broadcast finished")
        // Notify server of broadcast stop
        Task { await notifyServer(event: "stop") }
    }

    private func notifyServer(event: String) async {
        guard let url = URL(string: "\(baseURL)/broadcast/\(event)") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        _ = try? await session.data(for: request)
    }
}
