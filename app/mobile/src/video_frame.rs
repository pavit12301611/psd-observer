// video_frame.rs - Reads video frames from shared memory buffer (iOS App Groups)
//
// Memory layout (must match Swift VideoFrameBuffer):
// - Header (64 bytes):
//   - frame_size: u32    (current JPEG size in bytes)
//   - width: u32         (frame width)
//   - height: u32        (frame height)
//   - timestamp: f64     (last write time)
//   - sequence: u64      (frame counter for detecting new data)
//   - reserved: 36 bytes
// - Data section: 512KB (single JPEG frame)

use base64::Engine;
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::RwLock;
use tokio::time::interval;

use crate::server::FrameData;

use once_cell::sync::Lazy;

/// Static storage for App Group container path (set by Swift on iOS)
static APP_GROUP_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Global reader state for stopping the background task
static READER_STATE: Lazy<Mutex<Option<Arc<VideoFrameReaderState>>>> = Lazy::new(|| Mutex::new(None));

/// Set the App Group container path (called from Swift/iOS side)
pub fn set_app_group_path(path: PathBuf) {
    eprintln!("VideoFrameReader: App Group path set to {:?}", path);
    if let Ok(mut guard) = APP_GROUP_PATH.lock() {
        *guard = Some(path);
    }
}

// Buffer constants (must match Swift)
const HEADER_SIZE: usize = 64;
const DATA_BUFFER_SIZE: usize = 512 * 1024; // 512KB
const TOTAL_SIZE: usize = HEADER_SIZE + DATA_BUFFER_SIZE;

// Header offsets
const FRAME_SIZE_OFFSET: usize = 0;   // u32: 4 bytes
const WIDTH_OFFSET: usize = 4;        // u32: 4 bytes
const HEIGHT_OFFSET: usize = 8;       // u32: 4 bytes
const TIMESTAMP_OFFSET: usize = 12;   // f64: 8 bytes
const SEQUENCE_OFFSET: usize = 20;    // u64: 8 bytes

/// Video frame buffer reader for iOS shared memory
pub struct VideoFrameReader {
    mmap: Option<MmapMut>,
    last_sequence: u64,
    frame_count: u64,
}

impl VideoFrameReader {
    pub fn new() -> Self {
        Self {
            mmap: None,
            last_sequence: 0,
            frame_count: 0,
        }
    }

    /// Get the App Group container path for iOS
    fn get_app_group_path() -> Option<PathBuf> {
        // First check if path was set explicitly
        if let Some(path) = APP_GROUP_PATH.lock().ok()?.clone() {
            return Some(path);
        }

        #[cfg(target_os = "ios")]
        {
            // Try standard iOS App Group container locations
            let shared_containers = PathBuf::from("/private/var/mobile/Containers/Shared/AppGroup");
            if shared_containers.exists() {
                if let Ok(entries) = std::fs::read_dir(&shared_containers) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("video_frame.bin");
                        if candidate.exists() {
                            eprintln!(
                                "VideoFrameReader: Found frame buffer at {:?}",
                                entry.path()
                            );
                            return Some(entry.path());
                        }
                    }
                }
            }
            eprintln!("VideoFrameReader: App Group container not found");
            None
        }

        #[cfg(not(target_os = "ios"))]
        {
            // For testing on macOS, use a temp directory
            let path = PathBuf::from("/tmp/observer_video_frame");
            let _ = std::fs::create_dir_all(&path);
            Some(path)
        }
    }

    /// Initialize the memory-mapped file
    pub fn initialize(&mut self) -> io::Result<()> {
        let container_path = Self::get_app_group_path().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Failed to get App Group container path",
            )
        })?;

        let file_path = container_path.join("video_frame.bin");
        eprintln!("VideoFrameReader: Opening frame buffer at {:?}", file_path);

        // Open the file (it should already exist, created by Swift)
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&file_path)?;

        // Ensure file is the right size
        let metadata = file.metadata()?;
        if metadata.len() < TOTAL_SIZE as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "Frame buffer file too small: {} < {}",
                    metadata.len(),
                    TOTAL_SIZE
                ),
            ));
        }

        // Memory-map the file
        let mmap = unsafe { MmapMut::map_mut(&file)? };
        self.mmap = Some(mmap);

        // Initialize sequence to current value
        if let Some(ref mmap) = self.mmap {
            let sequence = u64::from_le_bytes(
                mmap[SEQUENCE_OFFSET..SEQUENCE_OFFSET + 8]
                    .try_into()
                    .unwrap(),
            );
            self.last_sequence = sequence;
            eprintln!(
                "VideoFrameReader: Initialized at sequence={}",
                sequence
            );
        }

        Ok(())
    }

    /// Read new frame from the buffer
    /// Returns (jpeg_bytes, width, height, timestamp) if new data is available
    pub fn read(&mut self) -> Option<(Vec<u8>, u32, u32, f64)> {
        let mmap = self.mmap.as_ref()?;

        // Read header
        let frame_size = u32::from_le_bytes(
            mmap[FRAME_SIZE_OFFSET..FRAME_SIZE_OFFSET + 4]
                .try_into()
                .unwrap(),
        );
        let width = u32::from_le_bytes(
            mmap[WIDTH_OFFSET..WIDTH_OFFSET + 4]
                .try_into()
                .unwrap(),
        );
        let height = u32::from_le_bytes(
            mmap[HEIGHT_OFFSET..HEIGHT_OFFSET + 4]
                .try_into()
                .unwrap(),
        );
        let timestamp = f64::from_le_bytes(
            mmap[TIMESTAMP_OFFSET..TIMESTAMP_OFFSET + 8]
                .try_into()
                .unwrap(),
        );
        let sequence = u64::from_le_bytes(
            mmap[SEQUENCE_OFFSET..SEQUENCE_OFFSET + 8]
                .try_into()
                .unwrap(),
        );

        // Check if there's new data
        if sequence == self.last_sequence {
            return None;
        }

        // Validate frame size
        if frame_size == 0 || frame_size as usize > DATA_BUFFER_SIZE {
            self.last_sequence = sequence;
            return None;
        }

        // Read JPEG data
        let data_start = HEADER_SIZE;
        let jpeg_data = mmap[data_start..data_start + frame_size as usize].to_vec();

        // Update state
        self.last_sequence = sequence;
        self.frame_count += 1;

        if self.frame_count == 1 {
            eprintln!(
                "VideoFrameReader: First frame read ({} bytes, {}x{})",
                jpeg_data.len(),
                width,
                height
            );
        }
        if self.frame_count % 100 == 0 {
            eprintln!(
                "VideoFrameReader: Read {} frames so far",
                self.frame_count
            );
        }

        Some((jpeg_data, width, height, timestamp))
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }
}

/// Shared state for the video frame reader task
pub struct VideoFrameReaderState {
    pub running: AtomicBool,
    pub frame_channel: Arc<RwLock<Option<Channel<FrameData>>>>,
}

impl VideoFrameReaderState {
    pub fn new(frame_channel: Arc<RwLock<Option<Channel<FrameData>>>>) -> Self {
        Self {
            running: AtomicBool::new(false),
            frame_channel,
        }
    }
}

/// Start the video frame reader background task
pub fn start_video_frame_reader(state: Arc<VideoFrameReaderState>) {
    // Store the state globally so we can stop it later
    if let Ok(mut guard) = READER_STATE.lock() {
        if let Some(existing) = guard.as_ref() {
            if existing.running.load(Ordering::SeqCst) {
                eprintln!("VideoFrameReader: Already running");
                return;
            }
        }
        *guard = Some(state.clone());
    }

    if state.running.swap(true, Ordering::SeqCst) {
        eprintln!("VideoFrameReader: Already running");
        return;
    }

    tokio::spawn(async move {
        eprintln!("VideoFrameReader: Starting background task");

        let mut reader = VideoFrameReader::new();

        // Try to initialize, retry if file doesn't exist yet
        let mut retry_count = 0;
        loop {
            match reader.initialize() {
                Ok(()) => {
                    eprintln!("VideoFrameReader: Successfully initialized");
                    break;
                }
                Err(e) => {
                    if retry_count < 30 {
                        // Retry for up to 30 seconds
                        retry_count += 1;
                        if retry_count == 1 {
                            eprintln!(
                                "VideoFrameReader: Waiting for frame buffer file to be created..."
                            );
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                    eprintln!("VideoFrameReader: Failed to initialize after 30s: {}", e);
                    state.running.store(false, Ordering::SeqCst);
                    return;
                }
            }
        }

        // Poll for new frames at ~33ms interval (~30fps)
        let mut poll_interval = interval(Duration::from_millis(33));

        while state.running.load(Ordering::SeqCst) {
            poll_interval.tick().await;

            // Read any new frame
            if let Some((jpeg_data, width, height, timestamp)) = reader.read() {
                // Check if there's a channel to send to
                let channel_guard = state.frame_channel.read().await;
                if let Some(channel) = channel_guard.as_ref() {
                    let frame_data = FrameData {
                        frame: jpeg_data,  // Raw JPEG bytes, no base64
                        timestamp,
                        width,
                        height,
                        frame_count: reader.frame_count(),
                    };

                    if let Err(e) = channel.send(frame_data) {
                        eprintln!("VideoFrameReader: Failed to send frame: {:?}", e);
                    }
                }
            }
        }

        eprintln!(
            "VideoFrameReader: Stopped after {} frames",
            reader.frame_count()
        );
    });
}

/// Stop the video frame reader background task
pub fn stop_video_frame_reader() {
    if let Ok(guard) = READER_STATE.lock() {
        if let Some(state) = guard.as_ref() {
            state.running.store(false, Ordering::SeqCst);
            eprintln!("VideoFrameReader: Stop requested");
        }
    }
}
