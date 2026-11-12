package dev.prynt

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.DisplayMetrics
import java.util.Locale
import java.util.TimeZone

/** Stable Android device attributes fed to the server-side matcher. */
internal object DeviceSignals {
    fun collect(ctx: Context): Map<String, Any> {
        val dm: DisplayMetrics = ctx.resources.displayMetrics
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am?.getMemoryInfo(it) }
        // ANDROID_ID survives reinstall (resets on factory reset); a useful secondary anchor.
        val androidId = runCatching {
            Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull() ?: ""
        return mapOf(
            "deviceModel" to Build.MODEL,
            "deviceManufacturer" to Build.MANUFACTURER,
            "deviceBoard" to Build.BOARD,
            "osVersion" to Build.VERSION.RELEASE,
            "sdkInt" to Build.VERSION.SDK_INT,
            "screen" to mapOf("w" to dm.widthPixels, "h" to dm.heightPixels, "density" to dm.densityDpi),
            "timezone" to TimeZone.getDefault().id,
            "languages" to mapOf("primary" to Locale.getDefault().toLanguageTag()),
            "hardwareConcurrency" to Runtime.getRuntime().availableProcessors(),
            "deviceMemory" to (mem.totalMem / 1_073_741_824L).toInt(),
            "abi" to (Build.SUPPORTED_ABIS?.firstOrNull() ?: ""),
            "androidId" to androidId,
            "vendor" to Build.MANUFACTURER,
        )
    }
}
