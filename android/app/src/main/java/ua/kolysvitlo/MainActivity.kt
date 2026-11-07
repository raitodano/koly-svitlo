package ua.kolysvitlo

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.time.Instant

/**
 * Головний екран — сам сайт «Коли світло?». Через міст KolySvitloApp сайт (вкладка
 * «Персоналізація») передає застосунку адресу для віджета й налаштування сповіщень.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val host = Uri.parse(Sched.SITE).host

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        BuildConfigHolder.version = packageManager.getPackageInfo(packageName, 0).versionName ?: "dev"
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "KolySvitloApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == host) return false
                startActivity(Intent(Intent.ACTION_VIEW, req.url)) // інші сайти — у браузері
                return true
            }
        }
        val start = if (Prefs(this).hasAddress) Sched.SITE else Sched.SITE + "#personal"
        if (savedInstanceState == null) web.loadUrl(start) else web.restoreState(savedInstanceState)
        Work.ensure(this)
        Work.fetchNow(this)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
    }

    private fun applyChanges() {
        WidgetRender.all(this)
        Alarms.scheduleNotifications(this)
        Work.fetchNow(this)
    }

    /** Методи, які викликає сайт. Виконуються не в UI-потоці. */
    inner class Bridge {
        @JavascriptInterface
        fun getState(): String {
            val p = Prefs(this@MainActivity)
            return JSONObject()
                .put("title", p.title ?: "")
                .put("loc", p.loc ?: "")
                .put("qids", org.json.JSONArray(p.qids))
                .put("notify", p.notify)
                .put("notifyMaybe", p.notifyMaybe)
                .put("canNotify", Alarms.canNotify(this@MainActivity))
                .put("canExact", Alarms.canExact(this@MainActivity))
                .put("lastFetch", if (p.lastFetch > 0) Instant.ofEpochMilli(p.lastFetch).toString() else "")
                .put("version", BuildConfigHolder.version)
                .toString()
        }

        @JavascriptInterface
        fun setAddress(json: String) {
            val o = try { JSONObject(json) } catch (e: Exception) { return }
            val qa = o.optJSONArray("qids") ?: return
            val qids = (0 until qa.length()).map { qa.optString(it) }.filter { it in Sched.SUBQ }
            val title = o.optString("title").trim().take(100)
            if (qids.isEmpty() || title.isEmpty()) return
            val p = Prefs(this@MainActivity)
            p.title = title
            p.loc = o.optString("loc").take(60)
            p.qids = qids
            runOnUiThread { if (p.notify) askNotifications(); applyChanges() }
        }

        @JavascriptInterface
        fun setNotify(enabled: Boolean, maybe: Boolean) {
            val p = Prefs(this@MainActivity)
            p.notify = enabled
            p.notifyMaybe = maybe
            runOnUiThread { if (enabled) askNotifications(); applyChanges() }
        }

        @JavascriptInterface
        fun openPermissions() {
            runOnUiThread {
                val i = if (!Alarms.canNotify(this@MainActivity)) {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName"))
                } else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                try { startActivity(i) } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                }
            }
        }
    }
}
