package dev.prynt

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Base64
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * Prynt Replay for Android — session replay of a native app in the same Replay console as the web.
 *
 * Low-rate screenshots (1 frame / s by default, only when the screen changed) with every EditText, password field
 * and view tagged `prynt-mask` painted over **on the device**; taps become clicks (rage clicks, frustration, Py and
 * issues work as on the web). Frames travel as rrweb events (an `<img>` whose `src` changes).
 *
 * ```kotlin
 * PryntReplay.start(application, PryntReplay.Options(publicKey = "pk_live_…", website = "acme.com"))
 * PryntReplay.identify("user_42")   // your own user id, never an email
 * ```
 * Mask anything else: `view.tag = "prynt-mask"` (or `maskAllText = true`).
 */
object PryntReplay {
    data class Options(
        val publicKey: String,
        val website: String,
        val endpoint: String = "https://api.pryntid.com",
        val framesPerSecond: Double = 1.0,
        val scale: Float = 0.5f,
        val jpegQuality: Int = 45,
        val maskAllText: Boolean = false,
        var consent: Boolean = true,
        val visitorId: String? = null,
    )

    @Volatile var state = "off"; private set
    /** Extra regions to paint over, in dp (Flutter text fields the view tree cannot see). */
    @Volatile var extraMasksDp: List<android.graphics.RectF> = emptyList()
    private var opts: Options? = null
    private lateinit var prefs: android.content.SharedPreferences
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val events = mutableListOf<JSONObject>()
    private var bytes = 0
    private var seq = 0
    private var sessionId = ""
    private var lastFrame = 0
    private var lastScreen = ""
    private var lastSize = 0 to 0
    private var needFull = true
    private var lastFlush = 0L
    private var maskAll = false
    private var activity: WeakReference<Activity>? = null
    private const val IMG = 5

    // --- public API -------------------------------------------------------------------------------------------------
    fun start(app: Application, options: Options) {
        if (!options.publicKey.startsWith("pk_") || state == "recording" || state == "starting") return
        opts = options
        prefs = app.getSharedPreferences("prynt.replay", Context.MODE_PRIVATE)
        if (!options.consent) { state = "stopped:consent"; return }
        state = "starting"
        app.registerActivityLifecycleCallbacks(lifecycle)
        sessionId = currentSession()
        seq = prefs.getInt("seq.$sessionId", 0)
        io.execute {
            val q = "publicKey=${enc(options.publicKey)}&website=${enc(options.website)}&sessionId=${enc(sessionId)}"
            val (code, body) = http("GET", options.endpoint.trimEnd('/') + "/v1/replay/config?" + q, null)
            val cfg = runCatching { JSONObject(body) }.getOrNull()
            main.post {
                if (code != 200 || cfg?.optBoolean("record") != true) {
                    state = "stopped:" + (cfg?.optString("reason")?.takeIf { it.isNotEmpty() } ?: "config_$code"); return@post
                }
                maskAll = options.maskAllText || cfg.optBoolean("maskAllText")
                state = "recording"; needFull = true; lastFrame = 0; lastScreen = ""
                installCrashHandler()
                main.post(ticker)
            }
        }
    }

    fun stop() = main.post { halt("stopped", true) }

    /** Your own user id for this session (filters, helpdesk lookup, Intercom / Zendesk). Never an email. */
    fun identify(userId: String) {
        val uid = userId.trim()
        if (uid.isEmpty() || uid.contains('@')) return
        main.post { custom("prynt.identify", JSONObject().put("userId", uid.take(190))) }
    }

    fun setConsent(app: Application, given: Boolean) {
        val o = opts ?: return
        o.consent = given
        if (!given) main.post { halt("consent", true) } else if (state != "recording") start(app, o)
    }

    // --- lifecycle --------------------------------------------------------------------------------------------------
    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityResumed(a: Activity) {
            activity = WeakReference(a)
            wrapTouches(a.window)
            if (currentSession() != sessionId && state == "recording") { halt("new_session", true); opts?.let { start(a.application, it) } }
            needFull = true
        }
        override fun onActivityPaused(a: Activity) { prefs.edit().putLong("lastActive", System.currentTimeMillis()).apply(); flush(false) }
        override fun onActivityCreated(a: Activity, b: Bundle?) {}
        override fun onActivityStarted(a: Activity) {}
        override fun onActivityStopped(a: Activity) {}
        override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
        override fun onActivityDestroyed(a: Activity) {}
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (state != "recording") return
            tick()
            val fps = (opts?.framesPerSecond ?: 1.0).coerceIn(0.2, 4.0)
            main.postDelayed(this, (1000 / fps).toLong())
        }
    }

    private fun halt(reason: String, final: Boolean) {
        main.removeCallbacks(ticker)
        if (state == "recording") flush(final)
        state = "stopped:$reason"
    }

    // --- capture ----------------------------------------------------------------------------------------------------
    private fun tick() {
        val a = activity?.get() ?: return
        if (a.isFinishing) return
        val o = opts ?: return
        prefs.edit().putLong("lastActive", System.currentTimeMillis()).apply()
        val root = a.window.decorView
        if (root.width == 0 || root.height == 0) return
        val density = a.resources.displayMetrics.density
        val wDp = (root.width / density).toInt(); val hDp = (root.height / density).toInt()
        val screen = a.javaClass.simpleName.removeSuffix("Activity").ifEmpty { "App" }
        if (screen != lastScreen || (wDp to hDp) != lastSize) {
            val href = "app://${o.website}/$screen"
            push(JSONObject().put("type", 4).put("data", JSONObject().put("href", href).put("width", wDp).put("height", hDp)))
            if (lastScreen.isNotEmpty() && screen != lastScreen) custom("prynt.nav", JSONObject().put("href", href))
            lastScreen = screen; lastSize = wDp to hDp; needFull = true
        }
        val bw = (root.width * o.scale).toInt().coerceAtLeast(1); val bh = (root.height * o.scale).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
        val d = a.resources.displayMetrics.density * o.scale
        val masks = maskRects(root, o.scale) + extraMasksDp.map { Rect(((it.left - 4) * d).toInt(), ((it.top - 4) * d).toInt(), ((it.right + 4) * d).toInt(), ((it.bottom + 4) * d).toInt()) }
        val finish = { ok: Boolean -> if (ok) deliver(bmp, masks, wDp, hDp) else bmp.recycle() }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PixelCopy.request(a.window, bmp, { r -> finish(r == PixelCopy.SUCCESS) }, main)
            } catch (_: Exception) { finish(drawSoftware(root, bmp, o.scale)) }
        } else finish(drawSoftware(root, bmp, o.scale))
    }

    private fun drawSoftware(root: View, bmp: Bitmap, scale: Float): Boolean = try {
        val c = Canvas(bmp); c.scale(scale, scale); root.draw(c); true
    } catch (_: Exception) { false }

    private fun deliver(bmp: Bitmap, masks: List<Rect>, wDp: Int, hDp: Int) {
        val o = opts ?: return
        val c = Canvas(bmp)
        val p = Paint().apply { color = Color.rgb(140, 140, 140) }
        for (r in masks) c.drawRect(r, p)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, o.jpegQuality.coerceIn(10, 90), out)
        bmp.recycle()
        val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        val h = b64.hashCode()
        if (!needFull && h == lastFrame) return
        lastFrame = h
        val src = "data:image/jpeg;base64,$b64"
        if (needFull) {
            push(JSONObject().put("type", 2).put("data", JSONObject().put("node", snapshot(src, wDp, hDp))
                .put("initialOffset", JSONObject().put("top", 0).put("left", 0))))
            needFull = false
        } else {
            push(JSONObject().put("type", 3).put("data", JSONObject().put("source", 0).put("texts", JSONArray())
                .put("removes", JSONArray()).put("adds", JSONArray())
                .put("attributes", JSONArray().put(JSONObject().put("id", IMG).put("attributes", JSONObject().put("src", src))))))
        }
        if (bytes > 700_000 || System.currentTimeMillis() - lastFlush > 10_000) flush(false)
    }

    private fun maskRects(root: View, scale: Float): List<Rect> {
        val out = mutableListOf<Rect>()
        val loc = IntArray(2)
        fun walk(v: View) {
            if (v.visibility != View.VISIBLE || v.alpha < 0.01f) return
            if (shouldMask(v)) {
                v.getLocationInWindow(loc)
                out.add(Rect((loc[0] * scale).toInt(), (loc[1] * scale).toInt(), ((loc[0] + v.width) * scale).toInt(), ((loc[1] + v.height) * scale).toInt()))
                return
            }
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(root)
        return out
    }

    private fun shouldMask(v: View): Boolean {
        if ((v.tag as? String)?.contains("prynt-mask") == true) return true
        if ((v.contentDescription?.toString() ?: "").contains("prynt-mask")) return true
        if (v is EditText) return true                                   // inputs: always, like the web SDK
        if (v is TextView) {
            val cls = v.inputType and InputType.TYPE_MASK_VARIATION
            if (cls == InputType.TYPE_TEXT_VARIATION_PASSWORD || cls == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
                cls == InputType.TYPE_NUMBER_VARIATION_PASSWORD || cls == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD) return true
        }
        return maskAll && (v is TextView || v is ImageView)
    }

    private fun snapshot(src: String, w: Int, h: Int): JSONObject {
        val img = JSONObject().put("type", 2).put("tagName", "img").put("id", IMG).put("childNodes", JSONArray())
            .put("attributes", JSONObject().put("src", src).put("style", "display:block;width:100%;height:100%;object-fit:fill"))
        val body = JSONObject().put("type", 2).put("tagName", "body").put("id", 4).put("childNodes", JSONArray().put(img))
            .put("attributes", JSONObject().put("style", "margin:0;background:#000;width:${w}px;height:${h}px;overflow:hidden"))
        val head = JSONObject().put("type", 2).put("tagName", "head").put("id", 3).put("childNodes", JSONArray()).put("attributes", JSONObject())
        val html = JSONObject().put("type", 2).put("tagName", "html").put("id", 2).put("childNodes", JSONArray().put(head).put(body))
            .put("attributes", JSONObject())
        return JSONObject().put("type", 0).put("id", 1).put("childNodes", JSONArray().put(html))
    }

    // --- touches → clicks ---------------------------------------------------------------------------------------
    private fun wrapTouches(w: Window) {
        val cb = w.callback ?: return
        if (cb is TouchCallback) return
        w.callback = TouchCallback(cb) { e ->
            if (e.actionMasked == MotionEvent.ACTION_UP && state == "recording") {
                val d = w.context.resources.displayMetrics.density
                push(JSONObject().put("type", 3).put("data", JSONObject().put("source", 2).put("type", 2).put("id", IMG)
                    .put("x", (e.x / d).toInt()).put("y", (e.y / d).toInt())))
            }
        }
    }

    private class TouchCallback(private val inner: Window.Callback, private val onTouch: (MotionEvent) -> Unit) :
        Window.Callback by inner {
        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            try { onTouch(event) } catch (_: Exception) { /* never break the app */ }
            return inner.dispatchTouchEvent(event)
        }
    }

    // --- events + upload -------------------------------------------------------------------------------------------
    @Synchronized private fun push(ev: JSONObject) {
        ev.put("timestamp", System.currentTimeMillis())
        events.add(ev)
        bytes += ev.optJSONObject("data")?.toString()?.length ?: 64
    }

    private fun custom(tag: String, payload: JSONObject) {
        if (state != "recording") return
        push(JSONObject().put("type", 5).put("data", JSONObject().put("tag", tag).put("payload", payload)))
    }

    @Synchronized private fun flush(final: Boolean, sync: Boolean = false) {
        val o = opts ?: return
        if (events.isEmpty() && !final) return
        val batch = JSONArray(events.toList()); events.clear(); bytes = 0; lastFlush = System.currentTimeMillis()
        val body = JSONObject().put("publicKey", o.publicKey).put("website", o.website).put("sessionId", sessionId)
            .put("seq", seq).put("consent", o.consent).put("consentSource", "config").put("final", final)
            .put("visitorId", o.visitorId ?: JSONObject.NULL).put("platform", "android").put("events", batch)
        seq += 1
        prefs.edit().putInt("seq.$sessionId", seq).apply()
        val url = o.endpoint.trimEnd('/') + "/v1/replay/chunk?pk=" + enc(o.publicKey)
        val job = Runnable {
            val (code, _) = http("POST", url, body.toString())
            if (code in 400..499 && code != 429) main.post { halt("server_$code", false) }
        }
        if (sync) job.run() else io.execute(job)
    }

    private fun http(method: String, url: String, body: String?): Pair<Int, String> = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method; c.connectTimeout = 5000; c.readTimeout = 10_000
        c.setRequestProperty("User-Agent", userAgent)
        if (body != null) {
            c.doOutput = true; c.setRequestProperty("Content-Type", "text/plain")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        c.disconnect()
        code to text
    } catch (_: Exception) { 0 to "" }

    // --- helpers ---------------------------------------------------------------------------------------------------
    private fun currentSession(): String {
        val last = prefs.getLong("lastActive", 0)
        val sid = prefs.getString("sid", null)
        if (sid != null && System.currentTimeMillis() - last < 30 * 60 * 1000) return sid
        val alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
        val fresh = "rvs_" + (1..24).map { alphabet.random() }.joinToString("")
        prefs.edit().putString("sid", fresh).putLong("lastActive", System.currentTimeMillis()).apply()
        return fresh
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private val userAgent: String
        get() = "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}; ${Build.MODEL}) PryntReplay-Android/1.0"

    private var crashInstalled = false
    private fun installCrashHandler() {
        if (crashInstalled) return
        crashInstalled = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                push(JSONObject().put("type", 5).put("data", JSONObject().put("tag", "prynt.error").put("payload",
                    JSONObject().put("message", "${e.javaClass.simpleName}: ${e.message ?: ""}".take(500))
                        .put("stack", e.stackTrace.take(30).joinToString("\n") { it.toString() }).put("kind", "error"))))
                val th = Thread { flush(true, sync = true) }   // never network on the crashing (maybe main) thread
                th.start(); th.join(2000)
            } catch (_: Exception) { /* ignore */ }
            previous?.uncaughtException(t, e)
        }
    }
}
