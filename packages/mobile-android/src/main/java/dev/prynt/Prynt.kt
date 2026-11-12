package dev.prynt

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Prynt Android SDK — stable device identity + integrity signals, verified server-side.
 *
 * ```kotlin
 * val prynt = Prynt(context, "pk_live_…", "https://api.pryntid.com")
 * prynt.identify { result -> Log.d("prynt", result.visitorId) }
 * ```
 */
data class Confidence(val score: Double, val level: String)

data class IdentifyResult(
    val requestId: String,
    val visitorId: String,
    val visitorFound: Boolean,
    val confidence: Confidence,
    val raw: JSONObject,
)

sealed class PryntOutcome {
    data class Success(val result: IdentifyResult) : PryntOutcome()
    data class Failure(val error: Throwable) : PryntOutcome()
}

class Prynt(
    context: Context,
    private val apiKey: String,
    private val endpoint: String = "https://api.pryntid.com",
    private val extendedResult: Boolean = true,
    private val timeoutMs: Int = 6000,
) {
    private val appContext = context.applicationContext
    private val io = Executors.newSingleThreadExecutor()

    init { require(apiKey.startsWith("pk_")) { "[Prynt] apiKey must start with pk_" } }

    /** Identify this device off the main thread; the callback receives Success or Failure. */
    fun identify(tag: Map<String, Any?>? = null, linkedId: String? = null,
                 callback: (PryntOutcome) -> Unit) {
        io.execute {
            try { callback(PryntOutcome.Success(blockingIdentify(tag, linkedId))) }
            catch (t: Throwable) { callback(PryntOutcome.Failure(t)) }
        }
    }

    /** Synchronous identify (call from your own background thread / coroutine). */
    @Throws(Exception::class)
    fun blockingIdentify(tag: Map<String, Any?>? = null, linkedId: String? = null): IdentifyResult {
        val deviceId = Persist.deviceId(appContext)
        val signals = JSONObject(DeviceSignals.collect(appContext)).apply {
            put("platform", "android")
            put("rootTells", JSONObject(Integrity.rootTells()))
            put("fridaTells", JSONObject(Integrity.fridaTells()))
            put("emulatorTells", JSONObject(Integrity.emulatorTells(appContext)))
            put("integrityTells", JSONObject(Integrity.integrityTells(appContext)))
            PlayIntegrity.token(appContext, deviceId)?.let { put("attestation", JSONObject(it)) }
        }
        val body = JSONObject().apply {
            put("publicKey", apiKey)
            put("sdkVersion", VERSION)
            put("platform", "android")
            put("extendedResult", extendedResult)
            put("fingerprint", fingerprint(signals))
            put("signals", signals)
            put("identityHints", JSONObject(mapOf("cookie" to deviceId)))
            tag?.let { put("tag", JSONObject(it)) }
            linkedId?.let { put("linkedId", it) }
        }
        return post(body)
    }

    private fun fingerprint(signals: JSONObject): String {
        val scr = signals.optJSONObject("screen") ?: JSONObject()
        val parts = listOf(
            Build.MODEL, Build.MANUFACTURER, Build.DEVICE, Build.BOARD,
            signals.optString("osVersion"), "${scr.opt("w")}x${scr.opt("h")}",
            signals.optString("hardwareConcurrency"),
        ).filter { it.isNotEmpty() && it != "null" }
        val digest = MessageDigest.getInstance("SHA-256").digest(parts.joinToString("###").toByteArray())
        return digest.joinToString("") { "%02x".format(it) }.take(32)
    }

    private fun post(body: JSONObject): IdentifyResult {
        val conn = (URL(endpoint.trimEnd('/') + "/v1/identify").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = timeoutMs; readTimeout = timeoutMs
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: "{}"
        if (code !in 200..299) throw RuntimeException("[Prynt] identify failed: $code $text")
        val j = JSONObject(text)
        val c = j.optJSONObject("confidence") ?: JSONObject()
        return IdentifyResult(
            requestId = j.optString("requestId"),
            visitorId = j.optString("visitorId"),
            visitorFound = j.optBoolean("visitorFound"),
            confidence = Confidence(c.optDouble("score", 0.0), c.optString("level", "low")),
            raw = j,
        )
    }

    companion object { const val VERSION = "1.0.0" }
}
