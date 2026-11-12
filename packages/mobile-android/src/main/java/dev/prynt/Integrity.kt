package dev.prynt

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.os.Build
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/** Android integrity tells — raw evidence only; the SERVER decides rooted/tampered. */
internal object Integrity {

    private val SU_PATHS = listOf(
        "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su", "/vendor/bin/su",
        "/su/bin/su", "/system/bin/.ext/.su", "/system/usr/we-need-root/su",
    )
    private val ROOT_APPS = listOf(
        "com.topjohnwu.magisk", "eu.chainfire.supersu", "com.koushikdutta.superuser",
        "com.noshufou.android.su", "com.thirdparty.superuser", "com.zachspong.temprootremovejb",
    )
    private val MAGISK_PATHS = listOf("/sbin/.magisk", "/cache/.disable_magisk", "/init.magisk.rc", "/data/adb/magisk")

    fun rootTells(): Map<String, Any> {
        val su = SU_PATHS.filter { File(it).exists() }
        val magisk = MAGISK_PATHS.any { File(it).exists() } || which("magisk") != null
        val testKeys = (Build.TAGS ?: "").contains("test-keys")
        val dangerous = mutableListOf<String>()
        if (getProp("ro.debuggable") == "1") dangerous.add("ro.debuggable")
        if (getProp("ro.secure") == "0") dangerous.add("ro.secure")
        val rwSystem = runCatching {
            File("/proc/mounts").readLines().any { it.contains(" /system ") && it.contains(" rw,") }
        }.getOrDefault(false)
        val busybox = which("busybox") != null
        return mapOf(
            "suPaths" to su, "magisk" to magisk, "testKeys" to testKeys,
            "dangerousProps" to dangerous, "rwSystem" to rwSystem,
            "busybox" to busybox,
        )
    }

    fun fridaTells(): Map<String, Any> {
        val port = canConnect("127.0.0.1", 27042)
        var fridaLibs = false
        var gumThreads = false
        runCatching {
            File("/proc/self/maps").readLines().forEach {
                val l = it.lowercase()
                if (l.contains("frida") || l.contains("gadget") || l.contains("gum-js")) fridaLibs = true
            }
        }
        runCatching {
            File("/proc/self/task").listFiles()?.forEach { t ->
                val comm = File(t, "comm").takeIf { it.exists() }?.readText()?.trim() ?: ""
                if (comm.contains("gum-js") || comm.contains("gmain") || comm.contains("frida")) gumThreads = true
            }
        }
        val traced = runCatching {
            File("/proc/self/status").readLines().firstOrNull { it.startsWith("TracerPid:") }
                ?.substringAfter(":")?.trim()?.toIntOrNull() ?: 0
        }.getOrDefault(0) > 0
        return mapOf("port27042" to port, "fridaLibs" to if (fridaLibs) listOf("maps") else emptyList<String>(),
            "gumThreads" to gumThreads, "traced" to traced)
    }

    fun emulatorTells(ctx: Context): Map<String, Any> {
        val qemu = getProp("ro.kernel.qemu") == "1" || (Build.HARDWARE ?: "").contains("ranchu")
        val goldfish = (Build.HARDWARE ?: "").contains("goldfish") ||
            (Build.PRODUCT ?: "").contains("sdk") || (Build.PRODUCT ?: "").contains("emulator")
        val genymotion = (Build.MANUFACTURER ?: "").contains("Genymotion", true) ||
            (Build.PRODUCT ?: "").contains("vbox", true)
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val sensorsMissing = sm?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) == null
        return mapOf(
            "qemu" to qemu, "goldfish" to goldfish, "genymotion" to genymotion,
            "sensorsMissing" to sensorsMissing,
            "model" to "${Build.MODEL} ${Build.MANUFACTURER}",
            "fingerprint" to (Build.FINGERPRINT ?: ""),
            "abi" to (Build.SUPPORTED_ABIS?.firstOrNull() ?: ""),
        )
    }

    @Suppress("DEPRECATION")
    fun integrityTells(ctx: Context): Map<String, Any> {
        val pm = ctx.packageManager
        val pkg = ctx.packageName
        val installer = runCatching {
            if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(pkg).installingPackageName
            else pm.getInstallerPackageName(pkg)
        }.getOrNull() ?: ""
        val debuggable = (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val signatureHash = runCatching {
            val sigs = if (Build.VERSION.SDK_INT >= 28) {
                pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
                    .signingInfo?.apkContentsSigners
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures
            }
            val cert = sigs?.firstOrNull()?.toByteArray() ?: return@runCatching ""
            java.security.MessageDigest.getInstance("SHA-256").digest(cert)
                .joinToString("") { "%02x".format(it) }.take(32)
        }.getOrDefault("")
        return mapOf(
            "installer" to installer, "packageName" to pkg,
            "debuggable" to debuggable, "signatureHash" to signatureHash,
        )
    }

    // MARK: helpers
    private fun which(bin: String): String? =
        listOf("/system/bin/", "/system/xbin/", "/sbin/", "/vendor/bin/")
            .map { it + bin }.firstOrNull { File(it).exists() }

    private fun getProp(name: String): String = runCatching {
        val p = Runtime.getRuntime().exec(arrayOf("getprop", name))
        p.inputStream.bufferedReader().readLine()?.trim() ?: ""
    }.getOrDefault("")

    private fun canConnect(host: String, port: Int): Boolean = runCatching {
        Socket().use { it.connect(InetSocketAddress(host, port), 250); true }
    }.getOrDefault(false)
}
