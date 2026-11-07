package ua.kolysvitlo

import android.content.Context
import org.json.JSONArray

/** Налаштування й останній графік — у SharedPreferences. */
class Prefs(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("kolysvitlo", Context.MODE_PRIVATE)

    var title: String?
        get() = p.getString("title", null)
        set(v) = p.edit().putString("title", v).apply()

    var loc: String?
        get() = p.getString("loc", null)
        set(v) = p.edit().putString("loc", v).apply()

    var qids: List<String>
        get() = (p.getString("qids", "") ?: "").split(',').filter { it in Sched.SUBQ }
        set(v) = p.edit().putString("qids", v.joinToString(",")).apply()

    var notify: Boolean
        get() = p.getBoolean("notify", true)
        set(v) = p.edit().putBoolean("notify", v).apply()

    var notifyMaybe: Boolean
        get() = p.getBoolean("notifyMaybe", false)
        set(v) = p.edit().putBoolean("notifyMaybe", v).apply()

    var lastFetch: Long
        get() = p.getLong("lastFetch", 0)
        set(v) = p.edit().putLong("lastFetch", v).apply()

    var source: String
        get() = p.getString("source", "") ?: ""
        set(v) = p.edit().putString("source", v).apply()

    /** Скільки сповіщень заплановано (щоб скасувати старі, коли графік зміниться). */
    var scheduled: Int
        get() = p.getInt("scheduled", 0)
        set(v) = p.edit().putInt("scheduled", v).apply()

    val hasAddress: Boolean get() = !title.isNullOrBlank() && qids.isNotEmpty()

    fun days(): List<Sched.Day> = try {
        val a = JSONArray(p.getString("days", "[]"))
        (0 until a.length()).map { Sched.dayFromJson(a.getJSONObject(it)) }
    } catch (e: Exception) { emptyList() }

    fun saveDays(days: List<Sched.Day>) {
        val a = JSONArray()
        days.forEach { a.put(Sched.dayToJson(it)) }
        p.edit().putString("days", a.toString()).apply()
    }

    fun day(date: String): Sched.Day? = days().firstOrNull { it.date == date }
}
