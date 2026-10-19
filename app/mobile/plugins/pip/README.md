# Tauri PiP Plugin

Simple Picture-in-Picture plugin for iOS to keep the Observer app alive in the background.

## How It Works

When an agent starts on iOS, the plugin:
1. Creates a silent AVPlayer with a dummy video
2. Enables Picture-in-Picture mode
3. Configures audio session for background playback
4. Automatically enters PiP when the app goes to background

This keeps the main app's main_loop.ts running even when the app is backgrounded.

## Usage

The plugin is automatically invoked when agents start/stop:

```typescript
import { startMobilePip, stopMobilePip } from '@utils/mobilePip';

// Start PiP (called when first agent starts)
await startMobilePip();

// Stop PiP (called when last agent stops)
await stopMobilePip();
```

## Requirements

- iOS 13.0+
- Background audio mode enabled in Info.plist (already configured)
- AVPictureInPicture framework

## Files Modified

- `app/mobile/plugins/pip/` - New plugin directory
- `app/mobile/src/lib.rs` - Added plugin registration
- `app/mobile/Cargo.toml` - Added plugin dependency
- `app/src/utils/mobilePip.ts` - TypeScript wrapper
- `app/src/utils/main_loop.ts` - Auto-start/stop PiP with agents
- `app/mobile/gen/apple/observer-mobile_iOS/Info.plist` - Added UIBackgroundModes

## Testing

Build and run on iOS device:
```bash
cd app/mobile
tauri ios build
```

Start an agent and background the app - it should continue running with a small PiP window.

## Note

The current implementation uses a dummy video. In the future, this could be enhanced to:
- Render actual agent status in the PiP window
- Show live progress indicators
- Display agent state changes
