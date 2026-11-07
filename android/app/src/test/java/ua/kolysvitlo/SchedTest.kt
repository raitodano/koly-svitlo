package ua.kolysvitlo

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import java.net.URL
import java.time.Instant

/** Перевірка розбору графіка (запускається в GitHub Actions перед збиранням APK). */
class SchedTest {
    private fun samplePage(): String {
        // 2-ІІ (четверта підчерга): 04:00 помаранчеве, 04:30–07:30 немає, 07:30 помаранчеве
        val row = IntArray(48) { if (it in 8..15) 2 else 0 }.also { it[8] = 1; it[15] = 3 }
        val data = (0 until 12).flatMap { q -> row.map { if (q == 3) it else 0 } }
        val vals = data.joinToString(",") { "\"$it\"" }
        return """<script>var x = 1; var records = [ {"date":"2026-11-07","saved_at":"2026-11-06 19:02:03","data":[$vals]},
            {"date":"2026-11-07","saved_at":"2026-11-06 10:00:00","data":[]} ]; render(records);</script>"""
    }

    @Test
    fun parsesRecordsAndKeepsNewest() {
        val days = Sched.parseRecords(samplePage())
        assertEquals(1, days.size)
        val d = days[0]
        assertEquals("2026-11-06 19:02:03", d.savedAt)
        val w = Sched.windows(d.rows["2-ІІ"])
        assertEquals(1, w.size)
        assertTrue(w[0].off)
        assertEquals(8, w[0].from)
        assertEquals(16, w[0].to)
        assertTrue("вікно починається з помаранчевої півгодинки", w[0].startsWithSwitch)
        assertEquals("off", Sched.status(d.rows["2-ІІ"], 9 * 60).cls)
        assertEquals("on", Sched.status(d.rows["2-ІІ"], 3 * 60).cls)
        assertEquals("вимкнення о 04:00", Sched.status(d.rows["2-ІІ"], 3 * 60).small)
        assertEquals("Світла немає", Sched.combined(d, listOf("1-І", "2-ІІ"), 5 * 60).big)
    }

    @Test
    fun kyivSlotsIncludingDst() {
        assertEquals(Instant.parse("2026-11-07T06:00:00Z").toEpochMilli(), Sched.slotMillis("2026-11-07", 16))
        assertEquals(Instant.parse("2026-03-29T01:00:00Z").toEpochMilli(), Sched.slotMillis("2026-03-29", 8))
    }

    @Test
    fun jsonRoundTrip() {
        val d = Sched.parseRecords(samplePage())[0]
        val back = Sched.dayFromJson(Sched.dayToJson(d))
        for (q in Sched.SUBQ) assertArrayEquals(q, d.rows[q], back.rows[q])
    }

    /** Справжня сторінка ДПЕМ має розбиратися так само, як копія на сайті (dpem.py). */
    @Test
    fun livePageMatchesSiteCopy() {
        val page = try { URL(Sched.DPEM).readText() } catch (e: Exception) { null }
        Assume.assumeTrue("сайт ДПЕМ недоступний", page != null)
        val live = Sched.parseRecords(page!!)
        assertTrue(live.isNotEmpty())
        val site = try { Sched.parseDataJson(URL(Sched.SITE + "data.json").readText()) } catch (e: Exception) { null }
        Assume.assumeTrue("копія сайту недоступна", site != null)
        var compared = 0
        for (s in site!!) {
            val l = live.firstOrNull { it.date == s.date && it.savedAt == s.savedAt } ?: continue
            compared++
            for (q in Sched.SUBQ) assertArrayEquals("${s.date} $q", s.rows[q], l.rows[q])
        }
        assertTrue("немає спільних дат для порівняння", compared > 0)
    }
}
