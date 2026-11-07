package ua.kolysvitlo

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.URLEncoder
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** Будильники: оновлення віджета на межі півгодинок і сповіщення перед відключеннями. */
object Alarms {
    private const val TICK = 1000
    private const val NOTIFY_BASE = 2000
    private const val MAX_NOTIFY = 24
    const val CHANNEL = "outages"

    private fun am(ctx: Context) = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    fun canExact(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am(ctx).canScheduleExactAlarms()

    fun canNotify(ctx: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()

    private fun setAt(ctx: Context, at: Long, pi: PendingIntent) {
        if (canExact(ctx)) am(ctx).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am(ctx).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }

    /** Перемалювати віджет на початку наступної півгодинки. */
    fun scheduleTick(ctx: Context) {
        val now = Sched.now()
        val next = (now.minutes / 30 + 1)
        val date = if (next >= Sched.SLOTS) LocalDate.parse(now.date).plusDays(1).toString() else now.date
        val at = Sched.slotMillis(date, next % Sched.SLOTS) + 15_000
        val pi = PendingIntent.getBroadcast(ctx, TICK, Intent(ctx, TickReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        setAt(ctx, at, pi)
    }

    /**
     * Сповіщення на початку помаранчевої півгодинки (перемикання, код 1), тобто приблизно за 30 хв
     * до того, як не стане світла. Якщо вікно починається одразу з «немає» — за 30 хв до нього.
     */
    fun scheduleNotifications(ctx: Context) {
        val prefs = Prefs(ctx)
        for (i in 0 until maxOf(prefs.scheduled, MAX_NOTIFY)) {
            val pi = PendingIntent.getBroadcast(ctx, NOTIFY_BASE + i, Intent(ctx, NotifyReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
            if (pi != null) { am(ctx).cancel(pi); pi.cancel() }
        }
        prefs.scheduled = 0
        if (!prefs.notify || !prefs.hasAddress) return
        val now = System.currentTimeMillis()
        val today = Sched.now().date
        var n = 0
        for (date in listOf(today, LocalDate.parse(today).plusDays(1).toString())) {
            val day = prefs.day(date) ?: continue
            for (q in prefs.qids) {
                for (w in Sched.windows(day.rows[q])) {
                    if (!w.off && !prefs.notifyMaybe) continue
                    val slot = if (w.off && w.startsWithSwitch) w.from else maxOf(0, w.from - 1)
                    val at = Sched.slotMillis(date, slot)
                    if (at <= now + 30_000 || n >= MAX_NOTIFY) continue
                    val intent = Intent(ctx, NotifyReceiver::class.java)
                        .putExtra("date", date).putExtra("q", q).putExtra("from", w.from).putExtra("to", w.to).putExtra("off", w.off)
                    val pi = PendingIntent.getBroadcast(ctx, NOTIFY_BASE + n, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    setAt(ctx, at, pi)
                    n++
                }
            }
        }
        prefs.scheduled = n
    }

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            val ch = NotificationChannel(CHANNEL, ctx.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH)
            ch.description = ctx.getString(R.string.channel_desc)
            nm.createNotificationChannel(ch)
        }
    }
}

class TickReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        WidgetRender.all(ctx)
        if (System.currentTimeMillis() - Prefs(ctx).lastFetch > 40 * 60 * 1000) Work.fetchNow(ctx)
    }
}

class NotifyReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = Prefs(ctx)
        val date = intent.getStringExtra("date") ?: return
        val q = intent.getStringExtra("q") ?: return
        val from = intent.getIntExtra("from", -1)
        val off = intent.getBooleanExtra("off", true)
        // графік міг змінитися після планування — перевіряємо, що вікно ще є
        val w = Sched.windows(prefs.day(date)?.rows?.get(q)).firstOrNull { it.from == from && it.off == off } ?: return
        if (!prefs.notify || !Alarms.canNotify(ctx)) return
        Alarms.ensureChannel(ctx)
        val title = if (off) "⚡ Через ~30 хв не буде світла" else "Можливе відключення світла"
        val body = "${prefs.title} · $q: ${Sched.fmt(w.from)}–${Sched.fmt(w.to)}"
        val url = Sched.SITE + "?q=" + URLEncoder.encode(prefs.title ?: "", "UTF-8").replace("+", "%20")
        val open = PendingIntent.getActivity(ctx, 3, Intent(Intent.ACTION_VIEW, Uri.parse(url)), PendingIntent.FLAG_IMMUTABLE)
        val nb = android.app.Notification.Builder(ctx, Alarms.CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(android.app.Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(android.app.Notification.CATEGORY_REMINDER)
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify("$date-$q-$from".hashCode(), nb.build())
        WidgetRender.all(ctx)
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        WidgetRender.all(ctx)
        Alarms.scheduleNotifications(ctx)
        Work.ensure(ctx)
        Work.fetchNow(ctx)
    }
}

/** Фонове оновлення графіка (кожні 30 хв, коли є інтернет). */
class FetchWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val ok = Sched.fetchAndStore(applicationContext)
        WidgetRender.all(applicationContext)
        Alarms.scheduleNotifications(applicationContext)
        return if (ok) Result.success() else Result.retry()
    }
}

object Work {
    private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun ensure(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<FetchWorker>(30, TimeUnit.MINUTES).setConstraints(net).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("fetch", ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun fetchNow(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<FetchWorker>().setConstraints(net).build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("fetch-now", ExistingWorkPolicy.REPLACE, req)
    }
}
