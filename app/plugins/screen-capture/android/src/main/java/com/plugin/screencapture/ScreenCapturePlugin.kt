package com.plugin.screencapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "ScreenCapturePlugin"

@TauriPlugin
class ScreenCapturePlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        // Store projection data in companion object - accessible by service in same process
        @Volatile
        var mediaProjectionResultCode: Int = Activity.RESULT_CANCELED
        @Volatile
        var mediaProjectionData: Intent? = null
        @Volatile
        var isDataReady: Boolean = false

        // Streaming mode flags - used by service to determine callback type
        @Volatile
        var useJniVideoCallback: Boolean = false
        @Volatile
        var useJniAudioCallback: Boolean = false
    }

    // Audio capture manager for system audio (Android 10+)
    private var audioCaptureManager: AudioCaptureManager? = null

    // Pending invoke for video stream (waiting for MediaProjection permission)
    private var pendingVideoStreamInvoke: Invoke? = null

    @Command
    fun startCapture(invoke: Invoke) {
        Log.d(TAG, "startCapture called")

        activity.runOnUiThread {
            try {
                // Request media projection permission
                val mediaProjectionManager = activity.getSystemService(
                    Context.MEDIA_PROJECTION_SERVICE
                ) as MediaProjectionManager

                val captureIntent = mediaProjectionManager.createScreenCaptureIntent()

                // Start activity for result using Tauri's API
                startActivityForResult(invoke, captureIntent, "onMediaProjectionResult")
                Log.d(TAG, "MediaProjection permission dialog shown")

            } catch (e: Exception) {
                Log.e(TAG, "Error starting capture: ${e.message}", e)
                invoke.reject("Failed to start capture: ${e.message}")
            }
        }
    }

    @Command
    fun stopCapture(invoke: Invoke) {
        Log.d(TAG, "stopCapture called")

        try {
            // Stop the foreground service
            val stopIntent = Intent(activity, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_STOP
            }
            activity.stopService(stopIntent)

            // Clear stored projection data
            isDataReady = false
            mediaProjectionResultCode = Activity.RESULT_CANCELED
            mediaProjectionData = null

            Log.d(TAG, "Screen capture stopped")
            invoke.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping capture: ${e.message}", e)
            invoke.reject("Failed to stop capture: ${e.message}")
        }
    }

    @Command
    fun getFrame(invoke: Invoke) {
        // Deprecated - frontend uses get_broadcast_status instead
        invoke.reject("Use get_broadcast_status Tauri command instead")
    }

    // ==================== Channel-based streaming commands ====================

    @Command
    fun startVideoStream(invoke: Invoke) {
        Log.d(TAG, "startVideoStream called (JNI channel mode)")

        activity.runOnUiThread {
            try {
                // Set JNI callback mode
                useJniVideoCallback = true

                // If we already have MediaProjection permission, start immediately
                if (isDataReady && mediaProjectionResultCode == Activity.RESULT_OK && mediaProjectionData != null) {
                    Log.d(TAG, "Using existing MediaProjection permission")
                    startForegroundServiceForStreaming()
                    invoke.resolve()
                    return@runOnUiThread
                }

                // Otherwise, request permission
                pendingVideoStreamInvoke = invoke

                val mediaProjectionManager = activity.getSystemService(
                    Context.MEDIA_PROJECTION_SERVICE
                ) as MediaProjectionManager

                val captureIntent = mediaProjectionManager.createScreenCaptureIntent()
                startActivityForResult(invoke, captureIntent, "onVideoStreamPermissionResult")
                Log.d(TAG, "MediaProjection permission dialog shown for video stream")

            } catch (e: Exception) {
                Log.e(TAG, "Error starting video stream: ${e.message}", e)
                useJniVideoCallback = false
                invoke.reject("Failed to start video stream: ${e.message}")
            }
        }
    }

    @Command
    fun startAudioStream(invoke: Invoke) {
        Log.d(TAG, "startAudioStream called (JNI channel mode)")

        activity.runOnUiThread {
            try {
                // Check Android version - AudioPlaybackCapture requires Android 10+
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    invoke.reject("Audio capture requires Android 10 or later")
                    return@runOnUiThread
                }

                // Set JNI callback mode
                useJniAudioCallback = true

                // Need MediaProjection for audio capture too
                if (!isDataReady || mediaProjectionResultCode != Activity.RESULT_OK || mediaProjectionData == null) {
                    invoke.reject("MediaProjection not available. Start video stream first.")
                    return@runOnUiThread
                }

                // Get MediaProjection from service and start audio capture
                val mediaProjection = ScreenCaptureService.currentMediaProjection
                if (mediaProjection == null) {
                    invoke.reject("MediaProjection not active. Start video stream first.")
                    return@runOnUiThread
                }

                audioCaptureManager = AudioCaptureManager(mediaProjection)
                audioCaptureManager?.start()

                Log.d(TAG, "Audio stream started")
                invoke.resolve()

            } catch (e: Exception) {
                Log.e(TAG, "Error starting audio stream: ${e.message}", e)
                useJniAudioCallback = false
                invoke.reject("Failed to start audio stream: ${e.message}")
            }
        }
    }

    @Command
    fun stopVideoStream(invoke: Invoke) {
        Log.d(TAG, "stopVideoStream called")

        try {
            useJniVideoCallback = false

            // Stop the foreground service
            val stopIntent = Intent(activity, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_STOP
            }
            activity.stopService(stopIntent)

            // Note: Don't clear MediaProjection data - audio might still be using it
            Log.d(TAG, "Video stream stopped")
            invoke.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping video stream: ${e.message}", e)
            invoke.reject("Failed to stop video stream: ${e.message}")
        }
    }

    @Command
    fun stopAudioStream(invoke: Invoke) {
        Log.d(TAG, "stopAudioStream called")

        try {
            useJniAudioCallback = false
            audioCaptureManager?.stop()
            audioCaptureManager = null

            Log.d(TAG, "Audio stream stopped")
            invoke.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping audio stream: ${e.message}", e)
            invoke.reject("Failed to stop audio stream: ${e.message}")
        }
    }

    @ActivityCallback
    private fun onVideoStreamPermissionResult(invoke: Invoke, result: ActivityResult) {
        Log.d(TAG, "Video stream permission result: resultCode=${result.resultCode}")

        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            // Store the result
            mediaProjectionResultCode = result.resultCode
            mediaProjectionData = result.data
            isDataReady = true

            // Start the foreground service with JNI mode
            startForegroundServiceForStreaming()

            invoke.resolve()
        } else {
            useJniVideoCallback = false
            Log.w(TAG, "Video stream permission denied")
            invoke.reject("Screen capture permission denied")
        }
    }

    private fun startForegroundServiceForStreaming() {
        val serviceIntent = Intent(activity, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START_STREAMING
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(serviceIntent)
        } else {
            activity.startService(serviceIntent)
        }
        Log.d(TAG, "Foreground service started for streaming")
    }

    @ActivityCallback
    private fun onMediaProjectionResult(invoke: Invoke, result: ActivityResult) {
        Log.d(TAG, "MediaProjection result: resultCode=${result.resultCode}, data=${result.data}")

        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            // Store the result in companion object for the service to read
            mediaProjectionResultCode = result.resultCode
            mediaProjectionData = result.data
            isDataReady = true

            Log.d(TAG, "Stored projection data: resultCode=$mediaProjectionResultCode, data=$mediaProjectionData")

            // Start the foreground service
            startForegroundService()

            // Return true as a JSON value (Rust expects bool)
            invoke.resolve(JSObject().put("value", true))
        } else {
            Log.w(TAG, "MediaProjection permission denied or cancelled")
            invoke.reject("Screen capture permission denied")
        }
    }

    private fun startForegroundService() {
        val serviceIntent = Intent(activity, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(serviceIntent)
        } else {
            activity.startService(serviceIntent)
        }
        Log.d(TAG, "Foreground service started")
    }
}
