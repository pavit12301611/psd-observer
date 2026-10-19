import ReplayKit
import CoreImage
import CoreGraphics
import ImageIO
import AudioToolbox

/// Simple file-based debug logger for broadcast extension
/// Writes to App Group container so main app can read it
class DebugLog {
    static let shared = DebugLog()

    private let appGroupID = "group.com.observer.ai"
    private var logURL: URL?
    private var frameCount = 0
    private var audioCount = 0
    private var initError: String?

    private init() {
        // Try to get App Group container
        if let containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID) {
            logURL = containerURL.appendingPathComponent("broadcast_debug.log")
            // Clear previous log and write initial message
            let initMessage = "[\(Date())] DebugLog initialized at \(logURL!.path)\n"
            try? initMessage.write(to: logURL!, atomically: true, encoding: .utf8)
        } else {
            initError = "Failed to get App Group container for \(appGroupID)"
            NSLog("❌ DebugLog: \(initError!)")
        }
    }

    func log(_ message: String) {
        NSLog("📺 Broadcast: \(message)")  // Always log to system log

        guard let url = logURL else { return }
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(message)\n"

        // Simple append
        if let data = line.data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                handle.closeFile()
            }
        }
    }

    func logFrame() {
        frameCount += 1
        if frameCount == 1 || frameCount % 100 == 0 {
            log("Video frames: \(frameCount)")
        }
    }

    func logAudio() {
        audioCount += 1
        if audioCount == 1 || audioCount % 100 == 0 {
            log("Audio chunks: \(audioCount)")
        }
    }

    func getInitError() -> String? {
        return initError
    }
}

@objc(SampleHandler)
class SampleHandler: RPBroadcastSampleHandler {

    private var audioRingInitialized = false
    private var videoFrameInitialized = false

    override init() {
        super.init()

        // Log initialization
        DebugLog.shared.log("SampleHandler init")
        if let error = DebugLog.shared.getInitError() {
            NSLog("SampleHandler: DebugLog init error: \(error)")
        }
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        DebugLog.shared.log("Broadcast started")
        DebugLog.shared.log("Setup info: \(String(describing: setupInfo))")

        // Initialize video frame buffer for shared memory video
        videoFrameInitialized = VideoFrameBuffer.shared.initialize()
        if videoFrameInitialized {
            DebugLog.shared.log("VideoFrameBuffer initialized")
        } else {
            DebugLog.shared.log("VideoFrameBuffer failed to initialize")
        }

        // Initialize audio ring buffer for shared memory audio
        audioRingInitialized = AudioRingBuffer.shared.initialize()
        if audioRingInitialized {
            DebugLog.shared.log("AudioRingBuffer initialized")
        } else {
            DebugLog.shared.log("AudioRingBuffer failed to initialize")
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            handleVideoBuffer(sampleBuffer)
        case .audioApp, .audioMic:
            handleAudioBuffer(sampleBuffer)
        @unknown default:
            break
        }
    }

    private func handleVideoBuffer(_ sampleBuffer: CMSampleBuffer) {
        DebugLog.shared.logFrame()

        // Skip if video frame buffer not initialized
        guard videoFrameInitialized else { return }

        // Get pixel buffer
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            DebugLog.shared.log("No pixel buffer")
            return
        }

        // Get frame dimensions
        let width = UInt32(CVPixelBufferGetWidth(pixelBuffer))
        let height = UInt32(CVPixelBufferGetHeight(pixelBuffer))

        // Convert to JPEG
        guard let imageData = pixelBufferToData(pixelBuffer) else {
            DebugLog.shared.log("Failed to convert pixel buffer")
            return
        }

        // Write to shared memory buffer
        let timestamp = Date().timeIntervalSince1970
        VideoFrameBuffer.shared.write(jpegData: imageData, width: width, height: height, timestamp: timestamp)
    }

    private func handleAudioBuffer(_ sampleBuffer: CMSampleBuffer) {
        DebugLog.shared.logAudio()

        // Skip if ring buffer not initialized
        guard audioRingInitialized else { return }

        // Extract audio samples as floats
        guard let samples = audioBufferToFloats(sampleBuffer) else {
            DebugLog.shared.log("❌ Failed to extract audio samples")
            return
        }

        // Get audio format description
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        guard let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else { return }

        let sampleRate = UInt32(streamDescription.pointee.mSampleRate)
        let timestamp = Date().timeIntervalSince1970

        // Write to shared memory ring buffer
        AudioRingBuffer.shared.write(samples: samples, sampleRate: sampleRate, timestamp: timestamp)
    }

    private var audioFormatLogged = false

    private func audioBufferToFloats(_ sampleBuffer: CMSampleBuffer) -> [Float]? {
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )

        guard status == noErr else { return nil }
        defer { blockBuffer = nil }

        // Get the audio buffer
        guard let mData = audioBufferList.mBuffers.mData else { return nil }
        let dataSize = Int(audioBufferList.mBuffers.mDataByteSize)

        // Get format description to determine source format
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
        guard let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else { return nil }

        let sourceFormat = streamDescription.pointee.mFormatFlags
        let bytesPerSample = Int(streamDescription.pointee.mBitsPerChannel / 8)
        let channelCount = Int(streamDescription.pointee.mChannelsPerFrame)
        let sampleRate = streamDescription.pointee.mSampleRate
        let bytesPerFrame = Int(streamDescription.pointee.mBytesPerFrame)
        let framesPerPacket = streamDescription.pointee.mFramesPerPacket
        let isFloat = (sourceFormat & kAudioFormatFlagIsFloat) != 0
        let isInterleaved = (sourceFormat & kAudioFormatFlagIsNonInterleaved) == 0

        // Log format once for debugging
        if !audioFormatLogged {
            audioFormatLogged = true
            DebugLog.shared.log("🎵 Audio Format Debug:")
            DebugLog.shared.log("   - Sample Rate: \(sampleRate) Hz")
            DebugLog.shared.log("   - Channels: \(channelCount)")
            DebugLog.shared.log("   - Bits/Channel: \(streamDescription.pointee.mBitsPerChannel)")
            DebugLog.shared.log("   - Bytes/Sample: \(bytesPerSample)")
            DebugLog.shared.log("   - Bytes/Frame: \(bytesPerFrame)")
            DebugLog.shared.log("   - Frames/Packet: \(framesPerPacket)")
            DebugLog.shared.log("   - Is Float: \(isFloat)")
            DebugLog.shared.log("   - Is Interleaved: \(isInterleaved)")
            DebugLog.shared.log("   - Data size: \(dataSize) bytes")
            DebugLog.shared.log("   - Format flags: 0x\(String(sourceFormat, radix: 16))")

            // Calculate frames for this first chunk
            let firstNumFrames = dataSize / bytesPerFrame
            DebugLog.shared.log("   - Frames per chunk: \(firstNumFrames)")
            DebugLog.shared.log("   - Output: \(firstNumFrames) mono f32 samples (\(firstNumFrames * 4) bytes)")
            if channelCount == 2 {
                DebugLog.shared.log("   ✅ Stereo-to-mono downmix enabled")
            }
        }

        // Calculate number of FRAMES (a frame contains samples for all channels)
        let numFrames = dataSize / bytesPerFrame

        // Output is MONO - one float per frame (downmix stereo if needed)
        var floatData = [Float](repeating: 0, count: numFrames)

        // Check if source is already float
        if isFloat {
            if channelCount == 1 {
                // Mono float - direct copy
                mData.withMemoryRebound(to: Float.self, capacity: numFrames) { ptr in
                    floatData = Array(UnsafeBufferPointer(start: ptr, count: numFrames))
                }
            } else if channelCount == 2 && isInterleaved {
                // Stereo float interleaved - downmix to mono
                mData.withMemoryRebound(to: Float.self, capacity: numFrames * 2) { ptr in
                    for i in 0..<numFrames {
                        let left = ptr[i * 2]
                        let right = ptr[i * 2 + 1]
                        floatData[i] = (left + right) * 0.5
                    }
                }
            }
        } else {
            // Integer format - convert to float
            // Check endianness from format flags
            let isBigEndian = (sourceFormat & kAudioFormatFlagIsBigEndian) != 0

            if bytesPerSample == 2 {
                // Int16 format
                if channelCount == 1 {
                    // Mono Int16
                    mData.withMemoryRebound(to: Int16.self, capacity: numFrames) { ptr in
                        for i in 0..<numFrames {
                            var sample = ptr[i]
                            if isBigEndian {
                                sample = Int16(bigEndian: sample)
                            }
                            floatData[i] = Float(sample) / Float(Int16.max)
                        }
                    }
                } else if channelCount == 2 && isInterleaved {
                    // Stereo Int16 interleaved - downmix to mono
                    mData.withMemoryRebound(to: Int16.self, capacity: numFrames * 2) { ptr in
                        for i in 0..<numFrames {
                            var leftRaw = ptr[i * 2]
                            var rightRaw = ptr[i * 2 + 1]
                            if isBigEndian {
                                leftRaw = Int16(bigEndian: leftRaw)
                                rightRaw = Int16(bigEndian: rightRaw)
                            }
                            let left = Float(leftRaw) / Float(Int16.max)
                            let right = Float(rightRaw) / Float(Int16.max)
                            floatData[i] = (left + right) * 0.5
                        }
                    }
                }
            } else if bytesPerSample == 4 {
                // Int32 format
                if channelCount == 1 {
                    // Mono Int32
                    mData.withMemoryRebound(to: Int32.self, capacity: numFrames) { ptr in
                        for i in 0..<numFrames {
                            var sample = ptr[i]
                            if isBigEndian {
                                sample = Int32(bigEndian: sample)
                            }
                            floatData[i] = Float(sample) / Float(Int32.max)
                        }
                    }
                } else if channelCount == 2 && isInterleaved {
                    // Stereo Int32 interleaved - downmix to mono
                    mData.withMemoryRebound(to: Int32.self, capacity: numFrames * 2) { ptr in
                        for i in 0..<numFrames {
                            var leftRaw = ptr[i * 2]
                            var rightRaw = ptr[i * 2 + 1]
                            if isBigEndian {
                                leftRaw = Int32(bigEndian: leftRaw)
                                rightRaw = Int32(bigEndian: rightRaw)
                            }
                            let left = Float(leftRaw) / Float(Int32.max)
                            let right = Float(rightRaw) / Float(Int32.max)
                            floatData[i] = (left + right) * 0.5
                        }
                    }
                }
            }
        }

        return floatData
    }

    private func pixelBufferToData(_ pixelBuffer: CVPixelBuffer) -> Data? {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()

        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
            return nil
        }

        // Simplest JPEG encoding - Rust will handle everything else
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }

        CGImageDestinationAddImage(destination, cgImage, nil) // No options, just raw JPEG
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }

        return data as Data
    }

    override func broadcastFinished() {
        DebugLog.shared.log("Broadcast finished")

        // Cleanup video frame buffer
        if videoFrameInitialized {
            VideoFrameBuffer.shared.cleanup()
            DebugLog.shared.log("VideoFrameBuffer cleaned up")
        }

        // Cleanup audio ring buffer
        if audioRingInitialized {
            AudioRingBuffer.shared.cleanup()
            DebugLog.shared.log("AudioRingBuffer cleaned up")
        }
    }
}
