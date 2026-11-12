package dev.prynt

import android.content.Context

/** Google Play Integrity hook (hardware-backed attestation).
 *
 * Play Integrity needs your Google Cloud **project number** and app-level wiring, so the host
 * app supplies the token via [provider]; the SDK forwards it to the server, which verifies it
 * against Google (when configured). If no provider is set, attestation is simply absent —
 * identify() still works.
 *
 * ```kotlin
 * PlayIntegrity.provider = { nonce ->
 *     // Use com.google.android.play:integrity with your project number to obtain a token
 *     // for `nonce` and return it (blocking), or null on failure.
 *     obtainPlayIntegrityToken(nonce)
 * }
 * ```
 */
object PlayIntegrity {
    @Volatile
    var provider: ((challenge: String) -> String?)? = null

    internal fun token(ctx: Context, challenge: String): Map<String, Any>? {
        val t = try { provider?.invoke(challenge) } catch (_: Throwable) { null } ?: return null
        return mapOf("platform" to "android", "type" to "playIntegrity", "token" to t)
    }
}
