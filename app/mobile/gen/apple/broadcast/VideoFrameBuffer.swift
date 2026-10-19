import Foundation

/// Single-frame buffer for sharing video data between broadcast extension and main app via App Groups
///
/// Memory layout:
/// - Header (64 bytes):
///   - frame_size: UInt32   (current JPEG size in bytes)
///   - width: UInt32        (frame width)
///   - height: UInt32       (frame height)
///   - timestamp: Float64   (last write time)
///   - sequence: UInt64     (frame counter for detecting new data)
///   - reserved: 32 bytes
/// - Data section: 512KB (enough for one high-quality JPEG frame)
class VideoFrameBuffer {
    static let shared = VideoFrameBuffer()

    private let appGroupID = "group.com.observer.ai"
    private let fileName = "video_frame.bin"

    // Buffer layout constants
    private let headerSize: Int = 64
    private let dataBufferSize: Int = 512 * 1024  // 512KB for single JPEG frame
    private let totalSize: Int

    // Header offsets
    private let frameSizeOffset: Int = 0      // UInt32: 4 bytes
    private let widthOffset: Int = 4          // UInt32: 4 bytes
    private let heightOffset: Int = 8         // UInt32: 4 bytes
    private let timestampOffset: Int = 12     // Float64: 8 bytes
    private let sequenceOffset: Int = 20      // UInt64: 8 bytes
    // reserved: 36 bytes (offset 28-63)

    private var fileHandle: FileHandle?
    private var mappedData: UnsafeMutableRawPointer?
    private var isInitialized = false

    private init() {
        totalSize = headerSize + dataBufferSize
    }

    /// Initialize the frame buffer (creates/opens shared file)
    func initialize() -> Bool {
        guard !isInitialized else { return true }

        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        ) else {
            DebugLog.shared.log("VideoFrame: Failed to get App Group container")
            return false
        }

        let fileURL = containerURL.appendingPathComponent(fileName)
        DebugLog.shared.log("VideoFrame: Using file at \(fileURL.path)")

        // Create file if it doesn't exist
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            // Create with zeros
            let zeros = Data(count: totalSize)
            do {
                try zeros.write(to: fileURL)
                DebugLog.shared.log("VideoFrame: Created new file (\(totalSize) bytes)")
            } catch {
                DebugLog.shared.log("VideoFrame: Failed to create file: \(error.localizedDescription)")
                return false
            }
        } else {
            DebugLog.shared.log("VideoFrame: File already exists")
        }

        // Open for read/write
        do {
            fileHandle = try FileHandle(forUpdating: fileURL)
        } catch {
            DebugLog.shared.log("VideoFrame: Failed to open file: \(error.localizedDescription)")
            return false
        }

        // Memory map the file
        guard let fd = fileHandle?.fileDescriptor else {
            DebugLog.shared.log("VideoFrame: Failed to get file descriptor")
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
            DebugLog.shared.log("VideoFrame: mmap failed with errno \(errno)")
            mappedData = nil
            return false
        }

        isInitialized = true
        DebugLog.shared.log("VideoFrame: Initialized successfully")
        return true
    }

    private var writeCount: UInt64 = 0

    /// Write a JPEG frame to the shared buffer
    /// - Parameters:
    ///   - jpegData: JPEG-encoded frame data
    ///   - width: Frame width in pixels
    ///   - height: Frame height in pixels
    ///   - timestamp: Unix timestamp
    func write(jpegData: Data, width: UInt32, height: UInt32, timestamp: Double) {
        guard isInitialized, let data = mappedData else {
            return
        }

        writeCount += 1
        if writeCount == 1 {
            DebugLog.shared.log("VideoFrame: First write - \(jpegData.count) bytes, \(width)x\(height)")
        } else if writeCount % 100 == 0 {
            DebugLog.shared.log("VideoFrame: \(writeCount) writes")
        }

        let frameSize = UInt32(jpegData.count)
        guard frameSize <= dataBufferSize else {
            DebugLog.shared.log("VideoFrame: Frame too large (\(frameSize) > \(dataBufferSize))")
            return
        }

        // Write JPEG data to buffer section
        let dataStart = data.advanced(by: headerSize)
        _ = jpegData.withUnsafeBytes { srcBuffer in
            memcpy(dataStart, srcBuffer.baseAddress!, Int(frameSize))
        }

        // Update header fields
        data.storeBytes(of: frameSize, toByteOffset: frameSizeOffset, as: UInt32.self)
        data.storeBytes(of: width, toByteOffset: widthOffset, as: UInt32.self)
        data.storeBytes(of: height, toByteOffset: heightOffset, as: UInt32.self)
        data.storeBytes(of: timestamp, toByteOffset: timestampOffset, as: Float64.self)

        // Increment sequence number (this signals new data to reader)
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
        DebugLog.shared.log("VideoFrame: Cleaned up after \(writeCount) writes")
    }

    deinit {
        cleanup()
    }
}
