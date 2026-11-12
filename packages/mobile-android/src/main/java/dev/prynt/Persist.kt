package dev.prynt

import android.content.Context
import java.util.UUID

/** Stable device id kept in private SharedPreferences.
 *
 * Note (honest limitation): unlike the iOS Keychain, this does NOT survive an app uninstall —
 * Android has no reliable reinstall-surviving per-app store. Identity is therefore anchored by
 * the combination of this id, ANDROID_ID, the device fingerprint, and (when configured) Play
 * Integrity + the server-side linking graph. Auto-backup can extend its lifetime.
 */
internal object Persist {
    private const val PREFS = "dev.prynt.store"
    private const val KEY = "vid"

    fun deviceId(ctx: Context): String {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        sp.getString(KEY, null)?.let { return it }
        val fresh = "pd_" + UUID.randomUUID().toString().replace("-", "").lowercase()
        sp.edit().putString(KEY, fresh).apply()
        return fresh
    }
}
