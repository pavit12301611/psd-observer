package com.plugin.screencapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager

private const val TAG = "ScreenCaptureService"
private const val NOTIFICATION_CHANNEL_ID = "screen_capture_channel"
private const val NOTIFICATION_ID = 1001

class ScreenCaptureService : Service() {

    companion object {
        const val ACTION_START = "com.plugin.screencapture.ACTION_START"
        const val ACTION_START_STREAMING = "com.plugin.screencapture.ACTION_START_STREAMING"
        const val ACTION_STOP = "com.plugin.screencapture.ACTION_STOP"

        // Expose MediaProjection for audio capture (same process)
        @Volatile
        var currentMediaProjection: MediaProjection? = null
            private set

        init {
            // Load the native library for JNI
            try {
                System.loadLibrary("app_lib")
                Log.d(TAG, "Native library loaded successfully")
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "Failed to load native library: ${e.message}")
            }
        }
    }

    // JNI native method - sends raw RGBA bytes to Rust for processing
    private external fun nativeOnFrame(rgba: ByteArray, width: Int, height: Int, stride: Int)

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null

    private var screenWidth = 0
    private var screenHeight = 0
    private var screenDensity = 0

    private lateinit var handlerThread: HandlerThread
    private lateinit var handler: Handler

    private var isCapturing = false
    private var lastFrameTime = 0L
    private val minFrameInterval = 33L // ~30 fps max

    // Whether to use JNI callbacks (true) or legacy HTTP (false)
    private var useJniMode = false

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service created")

        // Initialize handler thread for ImageReader callbacks
        handlerThread = HandlerThread("ScreenCaptureThread")
        handlerThread.start()
        handler = Handler(handlerThread.looper)

        // Get screen metrics
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val windowMetrics = windowManager.currentWindowMetrics
            screenWidth = windowMetrics.bounds.width()
            screenHeight = windowMetrics.bounds.height()
        } else {
            @Suppress("DEPRECATION")
            val displayMetrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getMetrics(displayMetrics)
            screenWidth = displayMetrics.widthPixels
            screenHeight = displayMetrics.heightPixels
        }
        screenDensity = resources.displayMetrics.densityDpi

        Log.d(TAG, "Screen dimensions: ${screenWidth}x${screenHeight}, density: $screenDensity")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand: action=${intent?.action}")

        // On Android 14+, we MUST call startForeground immediately
        if (intent?.action == ACTION_START || intent?.action == ACTION_START_STREAMING) {
            try {
                startForegroundWithNotification()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start foreground: ${e.message}", e)
                stopSelf()
                return START_NOT_STICKY
            }
        }

        when (intent?.action) {
            ACTION_START -> {
                useJniMode = false
                startCaptureFromPlugin()
            }
            ACTION_START_STREAMING -> {
                useJniMode = ScreenCapturePlugin.useJniVideoCallback
                Log.d(TAG, "Starting in streaming mode (JNI: $useJniMode)")
                startCaptureFromPlugin()
            }
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
            }
        }

        return START_NOT_STICKY
    }

    private fun startCaptureFromPlugin() {
        try {
            val resultCode = ScreenCapturePlugin.mediaProjectionResultCode
            val data = ScreenCapturePlugin.mediaProjectionData
            val isReady = ScreenCapturePlugin.isDataReady

            Log.d(TAG, "Reading from companion: isReady=$isReady, resultCode=$resultCode, data=$data")

            if (isReady && resultCode != android.app.Activity.RESULT_CANCELED && data != null) {
                startCapture(resultCode, data)
            } else {
                Log.e(TAG, "Invalid result code or data")
                stopSelf()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error starting capture: ${e.message}", e)
            stopSelf()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundWithNotification() {
        createNotificationChannel()

        val notification = buildNotification()

        // On Android 14+, must specify the foreground service type
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        Log.d(TAG, "Foreground notification started")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Screen Capture",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Screen capture is active"
                setShowBadge(false)
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        // Try to launch the main app activity when notification is tapped
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = if (launchIntent != null) {
            PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        } else null

        return builder
            .setContentTitle("Observer Screen Capture")
            .setContentText("Screen capture is active")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun startCapture(resultCode: Int, data: Intent) {
        Log.d(TAG, "Starting capture with resultCode: $resultCode, JNI mode: $useJniMode")

        try {
            val mediaProjectionManager = getSystemService(
                Context.MEDIA_PROJECTION_SERVICE
            ) as MediaProjectionManager

            mediaProjection = mediaProjectionManager.getMediaProjection(resultCode, data)

            if (mediaProjection == null) {
                Log.e(TAG, "Failed to get MediaProjection")
                stopSelf()
                return
            }

            // Expose for audio capture
            currentMediaProjection = mediaProjection

            // Register callback for projection stop
            mediaProjection?.registerCallback(mediaProjectionCallback, handler)

            // Create ImageReader
            imageReader = ImageReader.newInstance(
                screenWidth,
                screenHeight,
                PixelFormat.RGBA_8888,
                2 // Max images - keep small to avoid memory issues
            )

            imageReader?.setOnImageAvailableListener(imageAvailableListener, handler)

            // Create VirtualDisplay
            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "ScreenCapture",
                screenWidth,
                screenHeight,
                screenDensity,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader?.surface,
                null,
                handler
            )

            isCapturing = true

            Log.d(TAG, "Screen capture started successfully (JNI: $useJniMode)")

        } catch (e: Exception) {
            Log.e(TAG, "Error starting capture: ${e.message}", e)
            stopCapture()
            stopSelf()
        }
    }

    private val mediaProjectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.d(TAG, "MediaProjection stopped by system")
            stopCapture()
        }
    }

    private val imageAvailableListener = ImageReader.OnImageAvailableListener { reader ->
        if (!isCapturing) return@OnImageAvailableListener

        val currentTime = System.currentTimeMillis()
        if (currentTime - lastFrameTime < minFrameInterval) {
            // Skip frame to maintain frame rate limit
            reader.acquireLatestImage()?.close()
            return@OnImageAvailableListener
        }
        lastFrameTime = currentTime

        var image: Image? = null
        try {
            image = reader.acquireLatestImage()
            if (image == null) return@OnImageAvailableListener

            if (useJniMode) {
                // JNI mode: Pass raw RGBA bytes to Rust for processing
                processFrameJni(image)
            }
            // Legacy HTTP mode is no longer supported - just skip

        } catch (e: Exception) {
            Log.e(TAG, "Error processing frame: ${e.message}")
        } finally {
            image?.close()
        }
    }

    private fun processFrameJni(image: Image) {
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val rowStride = plane.rowStride

            // Copy buffer to byte array
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)

            // Pass raw RGBA bytes to Rust via JNI
            // Rust will handle: stride removal, resize, JPEG encode, base64, channel send
            nativeOnFrame(bytes, image.width, image.height, rowStride)

        } catch (e: Exception) {
            Log.e(TAG, "Error in JNI frame processing: ${e.message}", e)
        }
    }

    private fun stopCapture() {
        Log.d(TAG, "Stopping capture")
        isCapturing = false

        try {
            virtualDisplay?.release()
            virtualDisplay = null

            imageReader?.close()
            imageReader = null

            mediaProjection?.unregisterCallback(mediaProjectionCallback)
            mediaProjection?.stop()
            mediaProjection = null
            currentMediaProjection = null

            Log.d(TAG, "Capture stopped and resources released")

        } catch (e: Exception) {
            Log.e(TAG, "Error stopping capture: ${e.message}", e)
        }
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed")
        stopCapture()
        handlerThread.quitSafely()
        super.onDestroy()
    }
}
