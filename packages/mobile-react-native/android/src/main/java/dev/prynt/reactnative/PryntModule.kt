package dev.prynt.reactnative

import com.facebook.react.bridge.*
import dev.prynt.Prynt
import dev.prynt.PryntOutcome

/** RN bridge → native Android SDK (dev.prynt.Prynt). Add the native SDK as a dependency of this
 *  module's build.gradle (project(":prynt-android") or the published AAR). */
class PryntModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "Prynt"

    @ReactMethod
    fun identify(apiKey: String, endpoint: String, tag: ReadableMap?, linkedId: String?, promise: Promise) {
        try {
            val prynt = Prynt(ctx, apiKey, endpoint)
            prynt.identify(tag?.toHashMap(), linkedId) { outcome ->
                when (outcome) {
                    is PryntOutcome.Success -> {
                        val r = outcome.result
                        val conf = Arguments.createMap().apply {
                            putDouble("score", r.confidence.score); putString("level", r.confidence.level)
                        }
                        val map = Arguments.createMap().apply {
                            putString("requestId", r.requestId)
                            putString("visitorId", r.visitorId)
                            putBoolean("visitorFound", r.visitorFound)
                            putMap("confidence", conf)
                        }
                        promise.resolve(map)
                    }
                    is PryntOutcome.Failure -> promise.reject("identify_failed", outcome.error.message, outcome.error)
                }
            }
        } catch (t: Throwable) {
            promise.reject("identify_failed", t.message, t)
        }
    }

    // Prynt Replay (native Android recorder): screenshots with inputs masked on the device, taps as clicks.
    @ReactMethod
    fun replayStart(publicKey: String, website: String, endpoint: String, maskAllText: Boolean, consent: Boolean) {
        val app = ctx.applicationContext as android.app.Application
        dev.prynt.PryntReplay.start(app, dev.prynt.PryntReplay.Options(publicKey = publicKey, website = website,
            endpoint = endpoint, maskAllText = maskAllText, consent = consent))
    }
    @ReactMethod fun replayIdentify(userId: String) = dev.prynt.PryntReplay.identify(userId)
    @ReactMethod fun replaySetConsent(given: Boolean) = dev.prynt.PryntReplay.setConsent(ctx.applicationContext as android.app.Application, given)
    @ReactMethod fun replayStop() { dev.prynt.PryntReplay.stop() }
}
