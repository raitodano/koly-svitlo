"""Завантаження та розбір графіків погодинних відключень (ГПВ)
з сайту ДПЕМ ПрАТ «Атомсервіс»: https://info.dpem.mk.ua/off_graf.html

На сторінці є дві частини:

1. JS-масив ``records`` — графік на кожну дату: 12 підчерг × 48 півгодинних
   слотів (рядки йдуть у порядку 1-І, 1-ІІ, 2-І, ... 6-ІІ). Значення слота:
   0 — світло є, 1 — перемикання (вимкнення), 2 — світла немає,
   3 — перемикання (увімкнення), 4 — можливе відключення.
2. HTML-таблиці «Підчерга N-І / N-ІІ» з переліком вулиць і будинків.
"""
from __future__ import annotations

import html
import json
import re
import urllib.request
from datetime import datetime, timezone

SOURCE_URL = "https://info.dpem.mk.ua/off_graf.html"
USER_AGENT = "Mozilla/5.0 (compatible; gpv-poshuk/1.0)"
SLOTS_PER_DAY = 48
SUBQUEUES = [f"{q}-{s}" for q in range(1, 7) for s in ("І", "ІІ")]  # кирилична «І»
MAX_DAYS = 14


class ParseError(RuntimeError):
    """Сторінка змінилась і її не вдалося розібрати."""


# --------------------------------------------------------------------------
# Завантаження
# --------------------------------------------------------------------------

def fetch_html(url: str = SOURCE_URL, timeout: float = 30) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept-Language": "uk,ru;q=0.8"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="replace")


def load(url: str = SOURCE_URL) -> dict:
    data = parse_page(fetch_html(url))
    data["source"] = url
    data["fetched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return data


def parse_page(page: str) -> dict:
    schedules = parse_schedules(page)
    queues = parse_queues(page)
    if not schedules:
        raise ParseError("Не знайдено графіків (масив records) на сторінці")
    if not queues:
        raise ParseError("Не знайдено таблиць з адресами черг на сторінці")
    return {
        "subqueues": SUBQUEUES,
        "slot_minutes": 30,
        "schedules": schedules[:MAX_DAYS],
        "queues": queues,
    }


# --------------------------------------------------------------------------
# Графіки (records)
# --------------------------------------------------------------------------

_RECORDS_RE = re.compile(r"\brecords\s*=\s*(\[\s*\{.*?\}\s*\])\s*;", re.S)


def _to_int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def parse_schedules(page: str) -> list[dict]:
    m = _RECORDS_RE.search(page)
    if not m:
        return []
    try:
        raw = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise ParseError(f"Не вдалося розібрати масив records: {e}") from e

    need = SLOTS_PER_DAY * len(SUBQUEUES)
    best: dict[str, dict] = {}
    for rec in raw:
        date = str(rec.get("date", ""))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            continue
        values = [_to_int(v) for v in (rec.get("data") or [])][:need]
        values += [None] * (need - len(values))  # невідомо, а не «світло є»
        saved = str(rec.get("saved_at") or "")
        if date in best and best[date]["saved_at"] >= saved:
            continue  # лишаємо найсвіжішу версію графіка на цю дату
        best[date] = {
            "date": date,
            "saved_at": saved,
            "rows": {
                sq: values[i * SLOTS_PER_DAY:(i + 1) * SLOTS_PER_DAY]
                for i, sq in enumerate(SUBQUEUES)
            },
        }
    return sorted(best.values(), key=lambda r: r["date"], reverse=True)


# --------------------------------------------------------------------------
# Таблиці адрес
# --------------------------------------------------------------------------

_SUBQ_TITLE_RE = re.compile(
    r'<div\s+class="title_p">\s*Підчерга\s*(\d+)\s*[-–]\s*([ІI]{1,2})\s*</div>', re.I
)
_TABLE_RE = re.compile(r"<table\b.*?</table>", re.S | re.I)
_TR_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S | re.I)
_TD_RE = re.compile(r"<td\b[^>]*>(.*?)</td>", re.S | re.I)


def html_to_text(fragment: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = s.replace("​", "").replace("﻿", "").replace("\xa0", " ")
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in s.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def _norm_locality(loc: str) -> str:
    loc = re.sub(r"\s+", " ", loc).strip()
    return re.sub(r"^(м|с|смт)\.\s*", lambda m: m.group(1) + ". ", loc, flags=re.I)


def parse_queues(page: str) -> list[dict]:
    marks = list(_SUBQ_TITLE_RE.finditer(page))
    by_id: dict[str, dict] = {}
    for i, m in enumerate(marks):
        q = int(m.group(1))
        sub = m.group(2).upper().replace("I", "І")
        sq = f"{q}-{sub}"
        end = marks[i + 1].start() if i + 1 < len(marks) else len(page)
        tm = _TABLE_RE.search(page, m.end(), end)
        rows = _parse_table(tm.group(0)) if tm else []
        by_id.setdefault(sq, {"id": sq, "queue": q, "rows": []})["rows"].extend(rows)
    order = {sq: i for i, sq in enumerate(SUBQUEUES)}
    queues = sorted(by_id.values(), key=lambda x: order.get(x["id"], 99))
    _reclassify_streets(queues)
    return queues


def _reclassify_streets(queues: list[dict]) -> None:
    """«Енергобудівників 2» без «вул.» — теж вулиця, якщо така вулиця є деінде."""
    known: dict[tuple, str] = {}
    for q in queues:
        for r in q["rows"]:
            for e in r["entries"]:
                if e["kind"] == "street":
                    known.setdefault((e["loc"], street_key(e["name"])), e["type"])
    for q in queues:
        for r in q["rows"]:
            for e in r["entries"]:
                if e["kind"] == "other" and _looks_like_street(e["name"]):
                    typ = known.get((e["loc"], street_key(e["name"])))
                    if typ is not None:
                        e["kind"], e["type"] = "street", typ


def _parse_table(table_html: str) -> list[dict]:
    rows = []
    prev = None
    for trm in _TR_RE.finditer(table_html):
        cells = [html_to_text(td) for td in _TD_RE.findall(trm.group(1))]
        if not cells:
            continue
        joined = " ".join(cells)
        if "Найменування" in joined or "№ фідеру" in joined:
            continue  # рядки заголовка
        if len(cells) < 5:
            if prev is None:
                continue
            cells = prev[: 5 - len(cells)] + cells  # rowspan у попередньому рядку
        elif len(cells) > 5:
            cells = cells[:4] + ["\n".join(cells[4:])]
        prev = cells
        locality = _norm_locality(cells[0])
        consumers = cells[4]
        entries, partial = parse_consumers(consumers, locality)
        rows.append({
            "locality": locality,
            "substation": cells[1],
            "feeder": cells[2],
            "switch": cells[3],
            "partial": partial,
            "text": consumers,
            "entries": entries,
        })
    return rows


# --------------------------------------------------------------------------
# Розбір переліку споживачів на вулиці / будинки
# --------------------------------------------------------------------------

_L = "A-Za-zА-Яа-яЄєІіЇїҐґ"
_HOUSE_RE = re.compile(
    rf"^\d+(?:\s?[-–]?\s?[{_L}](?![{_L}]))?(?:\s*[/\-–]\s*\d+(?:[{_L}](?![{_L}]))?)*$"
)
_TYPE_RE = re.compile(
    r"^(вулиця|вул\.|вул(?=\s)|бульвар|бульв\.|б-р\.?|проспект|просп\.|пр-кт\.?|пр-т\.?|"
    r"пр\.|провулок|пров\.|площа|пл\.|тупик|туп\.|мкр\.?)\s*(.+)$",
    re.I,
)
_TYPE_CANON = {
    "вулиця": "вул.", "вул.": "вул.", "вул": "вул.",
    "бульвар": "б-р", "бульв.": "б-р", "б-р": "б-р", "б-р.": "б-р",
    "проспект": "пр-т", "просп.": "пр-т", "пр-кт": "пр-т", "пр-кт.": "пр-т",
    "пр-т": "пр-т", "пр-т.": "пр-т", "пр.": "пр.",
    "провулок": "пров.", "пров.": "пров.",
    "площа": "пл.", "пл.": "пл.", "тупик": "туп.", "туп.": "туп.",
    "мкр": "мкр.", "мкр.": "мкр.",
}
_PARTIAL_RE = re.compile(r"^част(?:ково|ина|иново)\b\s*:?\s*", re.I)
_LOCALITY_INLINE_RE = re.compile(
    r"(?:^|(?<=\s))(смт\.?|с\.|м\.)\s*([А-ЯІЇЄҐ][а-яіїєґ'’ʼ\-]+)\s*:"
)
_NO_SPLIT_ABBR = {
    "вул", "пр", "просп", "пров", "пл", "смт", "с", "м", "туп", "мкр", "ім",
    "св", "буд", "б-р", "бульв", "пр-т", "пр-кт", "набер", "ст",
}
_ORG_WORDS = {"прат", "тов", "фоп", "днз", "кп", "пп", "дп", "гк", "дк", "ск", "азс"}


def _split_sentences(s: str) -> list[str]:
    """Ділить «...Київстар. ЧАСТКОВО: вул. ...» на частини, не чіпаючи «вул. X»."""
    parts, start = [], 0
    for m in re.finditer(r"\.\s+(?=[А-ЯІЇЄҐA-Z])", s):
        w = re.search(r"([\w\-]+)$", s[start:m.start()])
        word = w.group(1) if w else ""
        if word.lower() in _NO_SPLIT_ABBR or len(word) <= 1:
            continue
        if word.isalpha() and word.islower() and len(word) <= 5:
            continue  # скорочення на кшталт «майст. ТВКГ», «прод. магазини»
        parts.append(s[start:m.start()])
        start = m.end()
    parts.append(s[start:])
    return parts


def _split_tokens(seg: str) -> list[str]:
    """Ділить по комах і « – », не заходячи всередину лапок і дужок."""
    out, buf, depth, in_q = [], [], 0, False
    n = len(seg)
    for i, ch in enumerate(seg):
        if ch == '"':
            in_q = not in_q
        elif ch in "«(":
            depth += 1
        elif ch in "»)":
            depth = max(0, depth - 1)
        if depth == 0 and not in_q:
            if ch == ",":
                out.append("".join(buf))
                buf = []
                continue
            if ch in "-–—" and 0 < i < n - 1 and seg[i - 1] == " " and seg[i + 1] == " ":
                out.append("".join(buf))
                buf = []
                continue
        buf.append(ch)
    out.append("".join(buf))
    return [t.strip(" .;:") for t in out if t.strip(" .;:")]


def _is_house(tok: str) -> bool:
    return bool(_HOUSE_RE.match(tok.replace("№", "").strip()))


def _looks_like_street(name: str) -> bool:
    if not name or not name[0].isupper() or any(q in name for q in '"«»'):
        return False
    first = re.split(r"[\s.]", name, maxsplit=1)[0]
    if len(first) >= 2 and first.isupper():
        return False  # абревіатура: ДНЗ, МПЗ, ЄЮЗМ ...
    return first.lower() not in _ORG_WORDS


def _split_name(rest: str, is_street: bool) -> tuple[str, list[str], str]:
    """«Шевченка 10» → ("Шевченка", ["10"], ""); «Гідробудівників –16» → (…, [], "–16")."""
    rest = rest.strip()
    if any(q in rest for q in '"«»()'):
        return rest, [], ""
    m = re.match(r"^(?P<name>.*?\D)\s*(?P<sep>№|[-–])?\s*(?P<num>\d.*)$", rest)
    if m:
        name = m.group("name").strip(" -–№.,")
        num = m.group("num").strip()
        if name:
            if m.group("sep") in ("-", "–"):
                if not is_street:
                    return rest, [], ""  # «ДКП-1», «25-ДРПЧ» — це назва, а не номер
                return name, [], f"{m.group('sep')}{num}"
            if _HOUSE_RE.match(num):
                return name, [num], ""
    return rest.strip(" -–№"), [], ""


def street_key(name: str) -> str:
    """Ключ для зведення варіантів написання: «Набер. енергетіків» ≈ «Набережна Енергетиків»."""
    s = name.lower().replace("’", "").replace("'", "").replace("ʼ", "")
    s = s.translate(str.maketrans("іїыйєэёґ", "ииииеееґ")).replace("ь", "")
    return " ".join(w[:5] for w in re.findall(r"[а-яґa-z0-9]+", s))


def parse_consumers(text: str, locality: str) -> tuple[list[dict], bool]:
    """Розбирає текст клітинки «Споживачі» на записи вулиць/об'єктів."""
    entries: dict[tuple, dict] = {}
    partial = False
    current = None

    def add(loc, typ, name, houses, kind, note=""):
        key = (loc, name.lower(), kind)
        e = entries.get(key)
        if e is None:
            e = entries[key] = {
                "loc": loc, "type": typ, "name": name,
                "houses": [], "kind": kind, "note": note,
            }
        for h in houses:
            if h not in e["houses"]:
                e["houses"].append(h)
        if note and not e["note"]:
            e["note"] = note
        if typ and not e["type"]:
            e["type"] = typ
        return e

    def process(seg: str, loc: str):
        nonlocal partial, current
        seg_type, prev_street = None, False
        for tok in _split_tokens(seg):
            m = _PARTIAL_RE.match(tok)
            if m:
                partial = True
                tok = tok[m.end():].strip(" .;:")
                if not tok:
                    continue
            if _is_house(tok):
                if current is not None:
                    h = re.sub(r"\s+", "", tok.replace("№", ""))
                    if h not in current["houses"]:
                        current["houses"].append(h)
                continue
            # «вул. Промислова (КП "ЖЄО", ПСБМ)» — вміст дужок як окремі об'єкти;
            # «міський суд (1 поверх)» — дужки лишаються частиною назви
            bare = re.sub(r"\s*\([^()]*\)", "", tok).strip()
            if bare != tok and _TYPE_RE.match(bare):
                for part in re.findall(r"\(([^()]*)\)", tok):
                    for sub in _split_tokens(part):
                        add(loc, "", sub, [], "other")
                tok = bare
            if not tok:
                continue
            tm = _TYPE_RE.match(tok)
            if tm:
                typ = _TYPE_CANON.get(tm.group(1).lower(), tm.group(1))
                rest, kind, seg_type = tm.group(2), "street", typ
            elif seg_type and prev_street and _looks_like_street(tok):
                typ, rest, kind = seg_type, tok, "street"
            else:
                typ, rest, kind = "", tok, "other"
            name, houses, note = _split_name(rest, kind == "street")
            if not name:
                continue
            current = add(loc, typ, name, houses, kind, note)
            prev_street = kind == "street"

    loc = locality
    for line in text.split("\n"):
        for piece in line.split(";"):
            for seg in _split_sentences(piece):
                # «смт. Костянтинівка: вул. Творча, ...» — зміна населеного пункту
                while True:
                    lm = _LOCALITY_INLINE_RE.search(seg)
                    if not lm:
                        break
                    process(seg[:lm.start()], loc)
                    loc = _norm_locality(f"{lm.group(1).rstrip('.')}. {lm.group(2)}")
                    seg = seg[lm.end():]
                process(seg, loc)

    if _PARTIAL_RE.match(text.strip()):
        partial = True
    return list(entries.values()), partial


if __name__ == "__main__":  # швидка перевірка: py dpem.py [файл.html]
    import sys

    src = sys.argv[1] if len(sys.argv) > 1 else None
    page = open(src, encoding="utf-8").read() if src else fetch_html()
    d = parse_page(page)
    print("Дати:", ", ".join(s["date"] for s in d["schedules"]))
    for q in d["queues"]:
        print(f"\n=== {q['id']} ({len(q['rows'])} рядків)")
        for r in q["rows"]:
            print(f"  [{r['locality']} | {r['substation']} | ф.{r['feeder']}] partial={r['partial']}")
            for e in r["entries"]:
                hs = ", ".join(e["houses"])
                print(f"     {e['kind']:6} {e['loc']:22} {e['type']:5} {e['name']}"
                      f"{' : ' + hs if hs else ''}{' (' + e['note'] + ')' if e['note'] else ''}")
