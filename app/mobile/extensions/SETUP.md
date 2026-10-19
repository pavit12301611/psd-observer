# Broadcast Extension Setup Guide

## Quick Xcode Setup

1. **Open project:**
   ```bash
   cd app/mobile/gen/apple
   open observer-mobile.xcodeproj
   ```

2. **Add Broadcast Extension Target:**
   - File → New → Target
   - Select "Broadcast Upload Extension"
   - Product Name: `ObserverBroadcast`
   - Bundle ID: `com.observer.ai.broadcast`
   - Select your development team

3. **Replace generated files:**
   - Delete auto-generated `SampleHandler.swift` and `Info.plist` in Xcode
   - Right-click ObserverBroadcast folder → Add Files
   - Select files from `app/mobile/extensions/ObserverBroadcast/`:
     - `SampleHandler.swift`
     - `Info.plist`
     - `ObserverBroadcast.entitlements`

4. **Configure main app entitlements:**
   - Select main app target
   - Signing & Capabilities → Add Capability → "App Groups"
   - Add: `group.com.observer.ai`

5. **Configure extension entitlements:**
   - Select ObserverBroadcast target
   - Signing & Capabilities → Add Capability → "App Groups"
   - Add: `group.com.observer.ai`

6. **Build & run on device** (simulator doesn't support broadcast)

## Testing

1. Start Observer app
2. Open Control Center (swipe down from top-right)
3. Long-press Screen Recording button
4. Select "Observer" from list
5. Tap "Start Broadcast"
6. Switch to any app - Observer will receive frames via localhost:8080

## Troubleshooting

- **Extension not appearing:** Check bundle ID and signing
- **Frames not received:** Check Xcode console for extension logs
- **Server not running:** Ensure Tauri app started successfully (check logs for "Frame server listening")
