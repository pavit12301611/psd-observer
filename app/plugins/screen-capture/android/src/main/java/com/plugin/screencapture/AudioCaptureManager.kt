package com.plugin.screencapture

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.nio.ByteBuffer
import java.nio.ByteOrder

private const val TAG = "AudioCaptureManager"

/**
 * Manages system audio capture using AudioPlaybackCapture (Android 10+).
 * Captures audio from other apps and passes raw PCM data to Rust via JNI.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class AudioCaptureManager(private val mediaProjection: MediaProjection) {

    companion object {
        private const val SAMPLE_RATE = 48000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_FLOAT
        private const val BUFFER_SIZE_FACTOR = 2 // 2 seconds of buffer

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

    // JNI native method - sends raw PCM bytes to Rust for processing
    private external fun nativeOnAudio(pcm: ByteArray, sampleRate: Int)

    private var audioRecord: AudioRecord? = null
    private var isCapturing = false
    private val captureScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /**
     * Start capturing system audio.
     * Audio is passed to Rust via JNI for resampling and channel delivery.
     */
    fun start() {
        if (isCapturing) {
            Log.w(TAG, "Audio capture already running")
            return
        }

        try {
            val config = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()

            val bufferSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT
            ) * BUFFER_SIZE_FACTOR

            audioRecord = AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AUDIO_FORMAT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(CHANNEL_CONFIG)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .build()

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord failed to initialize")
                audioRecord?.release()
                audioRecord = null
                return
            }

            audioRecord?.startRecording()
            isCapturing = true

            Log.d(TAG, "Audio capture started (${SAMPLE_RATE}Hz, buffer: $bufferSize bytes)")

            // Start reading audio in a coroutine
            captureScope.launch {
                readAudioLoop()
            }

        } catch (e: SecurityException) {
            Log.e(TAG, "Security exception starting audio capture: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Error starting audio capture: ${e.message}", e)
        }
    }

    /**
     * Audio read loop - runs in coroutine on IO dispatcher
     */
    private fun readAudioLoop() {
        val floatBuffer = FloatArray(1024) // Read 1024 samples at a time

        Log.d(TAG, "Audio read loop started")

        while (isCapturing && captureScope.isActive) {
            try {
                val read = audioRecord?.read(
                    floatBuffer,
                    0,
                    floatBuffer.size,
                    AudioRecord.READ_BLOCKING
                ) ?: 0

                if (read > 0) {
                    // Convert float array to byte array (little-endian f32)
                    val byteBuffer = ByteBuffer
                        .allocate(read * 4)
                        .order(ByteOrder.LITTLE_ENDIAN)

                    for (i in 0 until read) {
                        byteBuffer.putFloat(floatBuffer[i])
                    }

                    // Pass to Rust via JNI
                    nativeOnAudio(byteBuffer.array(), SAMPLE_RATE)
                } else if (read < 0) {
                    Log.e(TAG, "AudioRecord read error: $read")
                    break
                }
            } catch (e: Exception) {
                if (isCapturing) {
                    Log.e(TAG, "Error reading audio: ${e.message}")
                }
                break
            }
        }

        Log.d(TAG, "Audio read loop ended")
    }

    /**
     * Stop capturing system audio.
     */
    fun stop() {
        Log.d(TAG, "Stopping audio capture")
        isCapturing = false

        try {
            captureScope.cancel()

            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null

            Log.d(TAG, "Audio capture stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping audio capture: ${e.message}", e)
        }
    }
}
