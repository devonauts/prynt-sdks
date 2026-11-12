package dev.prynt.flutter

import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.prynt.Prynt
import dev.prynt.PryntOutcome
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Flutter bridge → the native Android SDK (dev.prynt.Prynt). Add the native SDK as a
 *  dependency of this plugin's build.gradle (project(":prynt-android") or the published AAR). */
class PryntPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private var context: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "dev.prynt/sdk")
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method.startsWith("replay")) { handleReplay(call, result); return }
        if (call.method != "identify") { result.notImplemented(); return }
        val ctx = context ?: return result.error("no_context", "No application context", null)
        val prynt = Prynt(ctx, call.argument("apiKey")!!, call.argument("endpoint") ?: "https://api.pryntid.com")
        prynt.identify(call.argument("tag"), call.argument("linkedId")) { outcome ->
            Handler(Looper.getMainLooper()).post {
                when (outcome) {
                    is PryntOutcome.Success -> result.success(mapOf(
                        "requestId" to outcome.result.requestId,
                        "visitorId" to outcome.result.visitorId,
                        "visitorFound" to outcome.result.visitorFound,
                        "confidence" to mapOf(
                            "score" to outcome.result.confidence.score,
                            "level" to outcome.result.confidence.level)))
                    is PryntOutcome.Failure -> result.error("identify_failed", outcome.error.message, null)
                }
            }
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    /** Prynt Replay (native recorder) + the regions Dart reports (Flutter text fields, PryntMask), in dp. */
    private fun handleReplay(call: MethodCall, result: MethodChannel.Result) {
        val app = context?.applicationContext as? android.app.Application ?: return result.error("no_context", "No application", null)
        when (call.method) {
            "replayStart" -> dev.prynt.PryntReplay.start(app, dev.prynt.PryntReplay.Options(
                publicKey = call.argument("publicKey") ?: "", website = call.argument("website") ?: "",
                endpoint = call.argument("endpoint") ?: "https://api.pryntid.com",
                maskAllText = call.argument("maskAllText") ?: false, consent = call.argument("consent") ?: true))
            "replayIdentify" -> dev.prynt.PryntReplay.identify(call.argument("userId") ?: "")
            "replaySetConsent" -> dev.prynt.PryntReplay.setConsent(app, call.argument("given") ?: false)
            "replayStop" -> dev.prynt.PryntReplay.stop()
            "replayMasks" -> {
                val rects = (call.argument<List<List<Double>>>("rects") ?: emptyList()).filter { it.size == 4 }
                    .map { android.graphics.RectF(it[0].toFloat(), it[1].toFloat(), it[2].toFloat(), it[3].toFloat()) }
                dev.prynt.PryntReplay.extraMasksDp = rects
            }
            else -> return result.notImplemented()
        }
        result.success(null)
    }
}
