package ua.kolysvitlo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.widget.RemoteViews
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Віджет на головному екрані: «Світло є / Світла немає» для обраної адреси. Натискання — сайт. */
class LightWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        WidgetRender.all(ctx)
        Work.ensure(ctx)
        if (System.currentTimeMillis() - Prefs(ctx).lastFetch > 25 * 60 * 1000) Work.fetchNow(ctx)
    }

    override fun onEnabled(ctx: Context) {
        Work.ensure(ctx)
        Work.fetchNow(ctx)
    }
}

object WidgetRender {
    private val BG = mapOf("on" to R.drawable.bg_on, "off" to R.drawable.bg_off, "maybe" to R.drawable.bg_maybe, "unknown" to R.drawable.bg_unknown)

    fun all(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, LightWidget::class.java))
        if (ids.isNotEmpty()) mgr.updateAppWidget(ids, build(ctx))
        Alarms.scheduleTick(ctx)
    }

    private fun build(ctx: Context): RemoteViews {
        val prefs = Prefs(ctx)
        val rv = RemoteViews(ctx.packageName, R.layout.widget)
        if (!prefs.hasAddress) {
            rv.setInt(R.id.root, "setBackgroundResource", R.drawable.bg_unknown)
            rv.setTextViewText(R.id.addr, ctx.getString(R.string.app_name))
            rv.setTextViewText(R.id.big, ctx.getString(R.string.pick_address))
            rv.setTextViewText(R.id.small, ctx.getString(R.string.pick_hint))
            rv.setTextViewText(R.id.updated, "")
            rv.setImageViewBitmap(R.id.bar, bar(null, null))
            val open = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            rv.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            return rv
        }
        val now = Sched.now()
        val day = prefs.day(now.date)
        val qids = prefs.qids
        val st = Sched.combined(day, qids, now.minutes)
        val fg = if (st.cls == "on") Color.parseColor("#2A1F00") else Color.parseColor("#F3EFE7")
        rv.setInt(R.id.root, "setBackgroundResource", BG[st.cls] ?: R.drawable.bg_unknown)
        for (id in intArrayOf(R.id.addr, R.id.big, R.id.small, R.id.updated)) rv.setTextColor(id, fg)
        rv.setTextViewText(R.id.addr, prefs.title)
        rv.setTextViewText(R.id.big, st.big)
        rv.setTextViewText(R.id.small, "${st.small} · ${qids.joinToString(", ")}")
        rv.setImageViewBitmap(R.id.bar, bar(day?.rows?.get(qids.first()), now.minutes))
        val upd = if (prefs.lastFetch > 0) {
            val f = SimpleDateFormat("HH:mm", Locale.getDefault()).apply { timeZone = TimeZone.getTimeZone(Sched.ZONE) }
            "${prefs.source} · ${f.format(Date(prefs.lastFetch))}"
        } else "оновлюю…"
        rv.setTextViewText(R.id.updated, upd)
        val url = Sched.SITE + "?q=" + URLEncoder.encode(prefs.title ?: "", "UTF-8").replace("+", "%20")
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        rv.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(ctx, 2, view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        return rv
    }

    /** Смужка на добу: 48 клітинок + риска «зараз». */
    private fun bar(v: IntArray?, nowMin: Int?): Bitmap {
        val w = 480; val h = 20
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        val cw = w / Sched.SLOTS.toFloat()
        for (i in 0 until Sched.SLOTS) {
            p.color = when (v?.get(i)) {
                0 -> Color.parseColor("#F4B740")
                2 -> Color.parseColor("#2B2F3A")
                1, 3 -> Color.parseColor("#E8823A")
                4 -> Color.parseColor("#8A7232")
                else -> Color.parseColor("#55FFFFFF")
            }
            c.drawRect(i * cw, 0f, (i + 1) * cw - 1.5f, h.toFloat(), p)
        }
        if (nowMin != null) {
            p.color = Color.WHITE
            val x = nowMin / 1440f * w
            c.drawRect(x - 2f, 0f, x + 2f, h.toFloat(), p)
        }
        return bmp
    }
}
