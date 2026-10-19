package com.plugin.pip

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class PipPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun startPip(invoke: Invoke) {
        // Android PiP implementation would go here
        // For now, just resolve successfully
        invoke.resolve()
    }

    @Command
    fun stopPip(invoke: Invoke) {
        // Android PiP implementation would go here
        invoke.resolve()
    }
}
