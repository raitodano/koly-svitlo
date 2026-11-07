package ua.kolysvitlo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Графік ДПЕМ: на кожну дату 12 підчерг × 48 півгодинних слотів.
 * Код слота: 0 — світло є, 1 — перемикання (вимкнення), 2 — світла немає,
 * 3 — перемикання (увімкнення), 4 — можливе відключення, -1 — немає даних.
 * Логіка та сама, що й у dpem.py / app.js на сайті.
 */
object Sched {
    const val SITE = "https://raitodano.github.io/koly-svitlo/"
    const val DPEM = "https://info.dpem.mk.ua/off_graf.html"
    const val SLOTS = 48
    val SUBQ = listOf("1-І", "1-ІІ", "2-І", "2-ІІ", "3-І", "3-ІІ", "4-І", "4-ІІ", "5-І", "5-ІІ", "6-І", "6-ІІ")
    val ZONE: ZoneId = try { ZoneId.of("Europe/Kyiv") } catch (e: Exception) { ZoneId.of("Europe/Kiev") }

    class Day(val date: String, val savedAt: String, val rows: Map<String, IntArray>)
    class Win(val off: Boolean, val from: Int, val to: Int, val startsWithSwitch: Boolean)
    class Status(val cls: String, val big: String, val small: String)
    class Now(val date: String, val minutes: Int)

    fun now(): Now {
        val z = ZonedDateTime.now(ZONE)
        return Now(z.toLocalDate().toString(), z.hour * 60 + z.minute)
    }

    /** Дата + слот за київським годинником → мить (мс). Враховує перехід на літній/зимовий час. */
    fun slotMillis(date: String, slot: Int): Long =
        LocalDate.parse(date).atStartOfDay().plusMinutes(slot * 30L).atZone(ZONE).toInstant().toEpochMilli()

    fun fmt(slot: Int): String = "%02d:%s".format(slot / 2, if (slot % 2 == 1) "30" else "00")

    // ---------------- розбір ----------------

    /** Масив `records = [...]` зі сторінки ДПЕМ (шукаємо вручну, без важкого regex на 1,5 МБ). */
    fun parseRecords(page: String): List<Day> {
        val head = Regex("""\brecords\s*=\s*\[""").find(page) ?: error("на сторінці ДПЕМ немає графіка")
        val start = head.range.last
        var i = start
        var end = -1
        while (true) {
            val b = page.indexOf('}', i)
            if (b < 0) break
            var j = b + 1
            while (j < page.length && page[j].isWhitespace()) j++
            if (j < page.length && page[j] == ']') {
                var k = j + 1
                while (k < page.length && page[k].isWhitespace()) k++
                if (k < page.length && page[k] == ';') { end = j; break }
            }
            i = b + 1
        }
        if (end < 0) error("не вдалося прочитати графік ДПЕМ")
        val arr = JSONArray(page.substring(start, end + 1))
        val best = HashMap<String, Day>()
        val dateRe = Regex("""\d{4}-\d{2}-\d{2}""")
        for (n in 0 until arr.length()) {
            val rec = arr.optJSONObject(n) ?: continue
            val date = rec.optString("date")
            if (!dateRe.matches(date)) continue
            val saved = rec.optString("saved_at")
            val prev = best[date]
            if (prev != null && prev.savedAt >= saved) continue
            val data = rec.optJSONArray("data") ?: JSONArray()
            val rows = HashMap<String, IntArray>()
            SUBQ.forEachIndexed { qi, q ->
                rows[q] = IntArray(SLOTS) { s -> val idx = qi * SLOTS + s; if (idx < data.length()) toCode(data.opt(idx)) else -1 }
            }
            best[date] = Day(date, saved, rows)
        }
        return best.values.sortedByDescending { it.date }
    }

    /** data.json із сайту (запасне джерело). */
    fun parseDataJson(text: String): List<Day> {
        val arr = JSONObject(text).getJSONArray("schedules")
        return (0 until arr.length()).map { n -> dayFromJson(arr.getJSONObject(n)) }
    }

    private fun toCode(v: Any?): Int = when (v) {
        is Number -> v.toInt()
        is String -> v.trim().toIntOrNull() ?: -1
        else -> -1
    }

    fun dayFromJson(o: JSONObject): Day {
        val rowsObj = o.getJSONObject("rows")
        val rows = HashMap<String, IntArray>()
        for (q in SUBQ) {
            val a = rowsObj.optJSONArray(q) ?: continue
            rows[q] = IntArray(SLOTS) { s -> if (s < a.length() && !a.isNull(s)) toCode(a.opt(s)) else -1 }
        }
        return Day(o.getString("date"), o.optString("saved_at"), rows)
    }

    fun dayToJson(d: Day): JSONObject {
        val rows = JSONObject()
        for ((q, v) in d.rows) rows.put(q, JSONArray().apply { v.forEach { put(if (it < 0) JSONObject.NULL else it) } })
        return JSONObject().put("date", d.date).put("saved_at", d.savedAt).put("rows", rows)
    }

    // ---------------- завантаження ----------------

    private fun download(url: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 20000
        c.readTimeout = 40000
        c.setRequestProperty("User-Agent", "KolySvitlo-Android/${BuildConfigHolder.version}")
        c.setRequestProperty("Cache-Control", "no-cache")
        try {
            if (c.responseCode !in 200..299) error("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally { c.disconnect() }
    }

    /** Свіжий графік: напряму з ДПЕМ (застосунок не обмежений CORS), інакше копія з сайту. */
    fun fetchAndStore(ctx: Context): Boolean {
        val fresh: List<Day>
        var source = "ДПЕМ"
        fresh = try {
            parseRecords(download(DPEM))
        } catch (e: Exception) {
            source = "копія сайту"
            try { parseDataJson(download(SITE + "data.json?t=" + System.currentTimeMillis())) } catch (e2: Exception) { return false }
        }
        val prefs = Prefs(ctx)
        val merged = HashMap<String, Day>()
        for (d in prefs.days() + fresh) {
            val p = merged[d.date]
            if (p == null || d.savedAt > p.savedAt) merged[d.date] = d
        }
        val from = LocalDate.parse(now().date).minusDays(1).toString()
        prefs.saveDays(merged.values.filter { it.date >= from }.sortedBy { it.date })
        prefs.lastFetch = System.currentTimeMillis()
        prefs.source = source
        return true
    }

    // ---------------- розрахунок ----------------

    fun windows(v: IntArray?): List<Win> {
        val out = ArrayList<Win>()
        if (v == null) return out
        var i = 0
        while (i < SLOTS) {
            val c = v[i]
            if (c == 1 || c == 2 || c == 3) {
                var j = i
                while (j < SLOTS && (v[j] == 1 || v[j] == 2 || v[j] == 3)) j++
                out.add(Win(true, i, j, c == 1)); i = j
            } else if (c == 4) {
                var j = i
                while (j < SLOTS && v[j] == 4) j++
                out.add(Win(false, i, j, false)); i = j
            } else i++
        }
        return out
    }

    fun status(v: IntArray?, nowMin: Int): Status {
        if (v == null || v.all { it < 0 }) return Status("unknown", "Немає даних", "графік не опубліковано")
        val slot = nowMin / 30
        val ws = windows(v)
        val cur = ws.firstOrNull { slot >= it.from && slot < it.to }
        if (cur != null && cur.off) return Status("off", "Світла немає", "до ${fmt(cur.to)}")
        if (cur != null) return Status("maybe", "Можливе вимкнення", "до ${fmt(cur.to)}")
        val next = ws.firstOrNull { it.off && it.from > slot }
        if (next != null) return Status("on", "Світло є", "вимкнення о ${fmt(next.from)}")
        return Status("on", "Світло є", "до кінця доби без вимкнень")
    }

    /** Для адреси на кількох лініях: «немає» важливіше за «можливе», а те — за «є». */
    fun combined(day: Day?, qids: List<String>, nowMin: Int): Status {
        val sts = qids.map { status(day?.rows?.get(it), nowMin) }
        return sts.firstOrNull { it.cls == "off" } ?: sts.firstOrNull { it.cls == "maybe" }
            ?: sts.firstOrNull { it.cls == "on" } ?: sts.firstOrNull() ?: Status("unknown", "Немає даних", "")
    }
}

/** Версія застосунку для User-Agent (заповнюється в App/MainActivity). */
object BuildConfigHolder { var version: String = "dev" }
