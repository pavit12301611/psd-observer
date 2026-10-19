import Foundation

/// Ring buffer for sharing audio data between broadcast extension and main app via App Groups
///
/// Memory layout:
/// - Header (64 bytes):
///   - write_pos: UInt64 (current write offset in ring buffer)
///   - sample_rate: UInt32 (e.g., 44100 on iOS)
///   - timestamp: Float64 (last write time)
///   - sequence: UInt64 (chunk counter for detecting new data)
///   - reserved: 36 bytes
/// - Ring buffer: 256KB of f32 samples (~65536 samples = ~1.5s at 44.1kHz)
class AudioRingBuffer {
    static let shared = AudioRingBuffer()

    private let appGroupID = "group.com.observer.ai"
    private let fileName = "audio_ring.bin"

    // Buffer layout constants
    private let headerSize: Int = 64
    private let ringBufferSize: Int = 256 * 1024  // 256KB = 65536 f32 samples
    private let totalSize: Int

    // Header offsets
    private let writePosOffset: Int = 0        // UInt64: 8 bytes
    private let sampleRateOffset: Int = 8      // UInt32: 4 bytes
    private let timestampOffset: Int = 12      // Float64: 8 bytes
    private let sequenceOffset: Int = 20       // UInt64: 8 bytes
    // reserved: 36 bytes (offset 28-63)

    private var fileHandle: FileHandle?
    private var mappedData: UnsafeMutableRawPointer?
    private var isInitialized = false

    private init() {
        totalSize = headerSize + ringBufferSize
    }

    /// Initialize the ring buffer (creates/opens shared file)
    func initialize() -> Bool {
        guard !isInitialized else { return true }

        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        ) else {
            DebugLog.shared.log("❌ AudioRing: Failed to get App Group container")
            return false
        }

        let fileURL = containerURL.appendingPathComponent(fileName)
        DebugLog.shared.log("🔊 AudioRing: Using file at \(fileURL.path)")

        // Create file if it doesn't exist
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            // Create with zeros
            let zeros = Data(count: totalSize)
            do {
                try zeros.write(to: fileURL)
                DebugLog.shared.log("🔊 AudioRing: Created new file (\(totalSize) bytes)")
            } catch {
                DebugLog.shared.log("❌ AudioRing: Failed to create file: \(error.localizedDescription)")
                return false
            }
        } else {
            DebugLog.shared.log("🔊 AudioRing: File already exists")
        }

        // Open for read/write
        do {
            fileHandle = try FileHandle(forUpdating: fileURL)
        } catch {
            DebugLog.shared.log("❌ AudioRing: Failed to open file: \(error.localizedDescription)")
            return false
        }

        // Memory map the file
        guard let fd = fileHandle?.fileDescriptor else {
            DebugLog.shared.log("❌ AudioRing: Failed to get file descriptor")
            return false
        }

        mappedData = mmap(
            nil,
            totalSize,
            PROT_READ | PROT_WRITE,
            MAP_SHARED,
            fd,
            0
        )

        if mappedData == MAP_FAILED {
            DebugLog.shared.log("❌ AudioRing: mmap failed with errno \(errno)")
            mappedData = nil
            return false
        }

        isInitialized = true
        DebugLog.shared.log("✅ AudioRing: Initialized successfully")
        return true
    }

    private var writeCount: UInt64 = 0

    /// Write audio samples to the ring buffer
    /// - Parameters:
    ///   - samples: Array of f32 PCM samples (mono)
    ///   - sampleRate: Sample rate (e.g., 48000)
    ///   - timestamp: Unix timestamp
    func write(samples: [Float], sampleRate: UInt32, timestamp: Double) {
        guard isInitialized, let data = mappedData else {
            return
        }

        writeCount += 1
        if writeCount == 1 {
            DebugLog.shared.log("🔊 AudioRing: First write - \(samples.count) samples at \(sampleRate)Hz")
        } else if writeCount % 500 == 0 {
            DebugLog.shared.log("🔊 AudioRing: \(writeCount) writes")
        }

        let sampleBytes = samples.count * MemoryLayout<Float>.size
        guard sampleBytes <= ringBufferSize else {
            DebugLog.shared.log("❌ AudioRing: Sample data too large")
            return
        }

        // Read current write position
        var writePos = data.load(fromByteOffset: writePosOffset, as: UInt64.self)

        // Calculate where to write in the ring buffer
        let ringOffset = Int(writePos % UInt64(ringBufferSize))
        let ringStart = data.advanced(by: headerSize)

        // Write samples (handle wrap-around)
        samples.withUnsafeBytes { srcBuffer in
            let src = srcBuffer.baseAddress!
            let bytesToEnd = ringBufferSize - ringOffset

            if sampleBytes <= bytesToEnd {
                // No wrap-around needed
                memcpy(ringStart.advanced(by: ringOffset), src, sampleBytes)
            } else {
                // Wrap around
                memcpy(ringStart.advanced(by: ringOffset), src, bytesToEnd)
                memcpy(ringStart, src.advanced(by: bytesToEnd), sampleBytes - bytesToEnd)
            }
        }

        // Update write position
        writePos += UInt64(sampleBytes)
        data.storeBytes(of: writePos, toByteOffset: writePosOffset, as: UInt64.self)

        // Update sample rate
        data.storeBytes(of: sampleRate, toByteOffset: sampleRateOffset, as: UInt32.self)

        // Update timestamp
        data.storeBytes(of: timestamp, toByteOffset: timestampOffset, as: Float64.self)

        // Increment sequence number
        var sequence = data.load(fromByteOffset: sequenceOffset, as: UInt64.self)
        sequence += 1
        data.storeBytes(of: sequence, toByteOffset: sequenceOffset, as: UInt64.self)

        // Flush to disk so reader can see it (non-blocking)
        // MS_ASYNC schedules flush but returns immediately - much lower latency
        msync(data, totalSize, MS_ASYNC)
    }

    /// Clean up resources
    func cleanup() {
        if let data = mappedData {
            munmap(data, totalSize)
            mappedData = nil
        }

        fileHandle?.closeFile()
        fileHandle = nil

        isInitialized = false
        DebugLog.shared.log("🔊 AudioRing: Cleaned up after \(writeCount) writes")
    }

    deinit {
        cleanup()
    }
}
