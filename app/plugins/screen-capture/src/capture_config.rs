//! Runtime-tunable screen-capture quality knobs: max width, JPEG quality, FPS.
//!
//! The frontend pushes these (see the `sc_set_capture_config` app command) right before
//! it starts a capture stream, and the platform capture code reads them when it builds
//! the stream / encodes each frame. There is deliberately no live-restart machinery: a
//! value change takes effect the next time capture starts (toggle the screen sensor),
//! which keeps this a plain read-at-build config with no stream-lifecycle coupling.
//!
//! Defaults match the "Low" tier — light and fast (≈ the pre-native-resolution behavior),
//! but sharper-per-pixel because the capture is now sized in real pixels, not points.

use std::sync::atomic::{AtomicU32, Ordering};

static MAX_WIDTH: AtomicU32 = AtomicU32::new(1280);
static JPEG_QUALITY: AtomicU32 = AtomicU32::new(55);
static TARGET_FPS: AtomicU32 = AtomicU32::new(10);

/// Store a new capture config. Values are clamped to sane ranges so a stray input field
/// can't hand the capture pipeline a zero width or a 1000fps interval.
pub fn set(max_width: u32, jpeg_quality: u8, fps: u32) {
    MAX_WIDTH.store(max_width.clamp(160, 7680), Ordering::Relaxed);
    JPEG_QUALITY.store(u32::from(jpeg_quality.clamp(1, 100)), Ordering::Relaxed);
    TARGET_FPS.store(fps.clamp(1, 120), Ordering::Relaxed);
}

/// Max output width in pixels; the source is downscaled to fit (aspect preserved).
pub fn max_width() -> u32 {
    MAX_WIDTH.load(Ordering::Relaxed)
}

/// JPEG encode quality, 1–100.
pub fn jpeg_quality() -> u8 {
    JPEG_QUALITY.load(Ordering::Relaxed) as u8
}

/// Target frames per second (an upper bound; static frames are dropped by the OS).
pub fn target_fps() -> u32 {
    TARGET_FPS.load(Ordering::Relaxed)
}
