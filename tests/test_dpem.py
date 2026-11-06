"""Тести розбору сторінки ДПЕМ.  Запуск:  py -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dpem  # noqa: E402


def entries(text, loc="м. Південноукраїнськ"):
    es, partial = dpem.parse_consumers(text, loc)
    return {(e["loc"], e["type"], e["name"]): e for e in es}, partial


class ParseConsumersTest(unittest.TestCase):
    def test_street_with_houses(self):
        es, partial = entries("Частково:\nб-р Шевченка 4, 9, 9А, 10, 12, 14;\nвул. Енергобудівників 3, 5, 7;")
        self.assertTrue(partial)
        self.assertEqual(es[("м. Південноукраїнськ", "б-р", "Шевченка")]["houses"], ["4", "9", "9А", "10", "12", "14"])
        self.assertEqual(es[("м. Південноукраїнськ", "вул.", "Енергобудівників")]["houses"], ["3", "5", "7"])

    def test_ranges_and_letters(self):
        es, _ = entries("пр-т Незалежності 22, 24, 33Б, 37-39;\nвул. Європейська 52, 54-Б, 5/2")
        self.assertEqual(es[("м. Південноукраїнськ", "пр-т", "Незалежності")]["houses"], ["22", "24", "33Б", "37-39"])
        self.assertEqual(es[("м. Південноукраїнськ", "вул.", "Європейська")]["houses"], ["52", "54-Б", "5/2"])

    def test_inline_locality_switch(self):
        es, _ = entries("МПЗ - вул.Незламних смт. Костянтинівка: вул. Творча, вул. Шевченка, вул. Франка;")
        self.assertIn(("м. Південноукраїнськ", "вул.", "Незламних"), es)
        self.assertIn(("смт. Костянтинівка", "вул.", "Шевченка"), es)
        self.assertEqual(es[("смт. Костянтинівка", "вул.", "Шевченка")]["houses"], [])

    def test_street_type_inherited_in_list(self):
        es, _ = entries("ДКП-1, кафе \"Пічка\", вул. Затишна, Прокоф'єва, Буго-Гардова, Героїв України.")
        for name in ("Затишна", "Прокоф'єва", "Буго-Гардова", "Героїв України"):
            self.assertEqual(es[("м. Південноукраїнськ", "вул.", name)]["kind"], "street")
        self.assertEqual(es[("м. Південноукраїнськ", "", "ДКП-1")]["kind"], "other")

    def test_sentence_split_keeps_abbreviations(self):
        es, partial = entries("вул. Свободи, ЄЮЗМ, Київстар. ЧАСТКОВО: вул. Паркова, пр. Дружби; майст. ТВКГ")
        self.assertTrue(partial)
        self.assertEqual(es[("м. Південноукраїнськ", "", "Київстар")]["kind"], "other")
        self.assertIn(("м. Південноукраїнськ", "вул.", "Паркова"), es)
        self.assertIn(("м. Південноукраїнськ", "пр.", "Дружби"), es)
        self.assertIn(("м. Південноукраїнськ", "", "майст. ТВКГ"), es)

    def test_parenthesis(self):
        es, _ = entries("вул. Промислова (КП \"ЖЄО\", ПСБМ); міський суд (1 поверх)")
        self.assertIn(("м. Південноукраїнськ", "вул.", "Промислова"), es)
        self.assertIn(("м. Південноукраїнськ", "", "ПСБМ"), es)
        self.assertIn(("м. Південноукраїнськ", "", "міський суд (1 поверх)"), es)


SAMPLE_PAGE = """
<script>
let records = [];
records = [
  {"date": "2026-11-06", "saved_at": "2026-11-06 10:58:07", "data": [%s]},
  {"date": "2026-11-05", "saved_at": "2026-11-06 08:51:26", "data": [%s]}
];
</script>
<div class="title_p">Підчерга 2-ІІ</div>
<table>
<tr class="xl6432197"><td>Найменування населеного пункту</td><td>…</td></tr>
<tr><td>м.Південноукраїнськ</td><td>ПС-35/10 кВ «Березка»</td><td>5</td><td>дист.</td>
<td>Частково<br />б-р Шевченка 4, 9, 10;<br />ДНЗ №9;</td></tr>
</table>
""" % (", ".join(['"2"'] * 576), ", ".join(['"0"'] * 576))


class ParsePageTest(unittest.TestCase):
    def test_page(self):
        d = dpem.parse_page(SAMPLE_PAGE)
        self.assertEqual([s["date"] for s in d["schedules"]], ["2026-11-06", "2026-11-05"])
        today = d["schedules"][0]
        self.assertEqual(len(today["rows"]), 12)
        self.assertEqual(today["rows"]["1-І"], [2] * 48)
        q = d["queues"][0]
        self.assertEqual(q["id"], "2-ІІ")
        row = q["rows"][0]
        self.assertEqual((row["locality"], row["feeder"], row["partial"]), ("м. Південноукраїнськ", "5", True))
        names = {e["name"]: e["houses"] for e in row["entries"]}
        self.assertEqual(names["Шевченка"], ["4", "9", "10"])
        self.assertEqual(names["ДНЗ"], ["9"])


if __name__ == "__main__":
    unittest.main()
