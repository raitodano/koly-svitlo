"""Збирає static/districts.json — які будинки й вулиці належать до мікрорайонів Південноукраїнська.

Межі мікрорайонів беремо з OpenStreetMap (© учасники OpenStreetMap, ліцензія ODbL):
полігони «1 мкр-н» … «5 мкр-н», «Малоповерхова забудова», ЖК «Престиж».
Кожен будинок з адресою (addr:street + addr:housenumber) відносимо до полігона, в якому
він стоїть, а якщо він трохи за межею (будинки вздовж межових вулиць) — до найближчого
в радіусі NEAR_M. Вулиці без номерів у переліках ДПЕМ відносимо до мікрорайонів,
через які вулиця проходить.

Запуск (раз на кілька місяців, результат комітиться):  py tools/build_districts.py
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "static" / "districts.json"
ENDPOINT = "https://overpass-api.de/api/interpreter"
USER_AGENT = "koly-svitlo/1.3 (https://github.com/raitodano/koly-svitlo)"
BBOX = "47.795,31.130,47.850,31.230"  # Південноукраїнськ разом з околицями
NEAR_M = 350

# id полігона в OSM → (ключ, як показувати)
OSM_WAYS = {
    877295531: ("m1", "1 мікрорайон"),
    891667401: ("m2", "2 мікрорайон"),
    877295530: ("m3", "3 мікрорайон"),
    877295529: ("m4", "4 мікрорайон"),
    891667878: ("m5", "5 мікрорайон"),
    892697544: ("low", "Малоповерхова забудова"),
    884646583: ("prestige", "ЖК «Престиж»"),
}


def overpass(query: str, tries: int = 5) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(ENDPOINT, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # Overpass часто перевантажений — пробуємо ще
            print(f"  спроба {attempt}: {e}", file=sys.stderr)
            time.sleep(15 * attempt)
    raise RuntimeError("Overpass API не відповідає")


# ---------- геометрія (метри в локальній проєкції — для міста цього досить) ----------

LAT0 = 47.82
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def xy(lat: float, lon: float) -> tuple[float, float]:
    return lon * KX, lat * KY


def inside(pt, poly) -> bool:
    x, y = pt
    res = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            res = not res
    return res


def dist_to_poly(pt, poly) -> float:
    if inside(pt, poly):
        return 0.0
    x, y = pt
    best = math.inf
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best


def nearest(pt, polys: dict) -> str | None:
    d, key = min((dist_to_poly(pt, p), k) for k, p in polys.items())
    return key if d <= NEAR_M else None


def _num_key(h: str):
    m = re.match(r"\d+", h)
    return (int(m.group(0)) if m else 0, h)


def main() -> None:
    ids = ",".join(str(i) for i in OSM_WAYS)
    print("Межі мікрорайонів…")
    geo = overpass(f"[out:json][timeout:90];way(id:{ids});out geom;")
    polys = {}
    for el in geo["elements"]:
        key = OSM_WAYS[el["id"]][0]
        polys[key] = [xy(p["lat"], p["lon"]) for p in el["geometry"]]
    print(f"  {len(polys)} полігонів")

    print("Будинки з адресами й вулиці…")
    res = overpass(f"""[out:json][timeout:150];
(way({BBOX})["addr:housenumber"]["addr:street"];node({BBOX})["addr:housenumber"]["addr:street"];
 relation({BBOX})["addr:housenumber"]["addr:street"];);
out tags center;
way({BBOX})["highway"]["name"];
out tags geom;""")

    houses = {k: {} for k in polys}
    streets = {k: set() for k in polys}
    for el in res["elements"]:
        t = el.get("tags", {})
        if "highway" in t:
            name = t.get("name:uk") or t["name"]
            for p in el.get("geometry", []):
                k = nearest(xy(p["lat"], p["lon"]), polys)
                if k and dist_to_poly(xy(p["lat"], p["lon"]), polys[k]) == 0:
                    streets[k].add(name)
            continue
        c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
        if not c:
            continue
        k = nearest(xy(c["lat"], c["lon"]), polys)
        if not k:
            continue
        street = t.get("addr:street:uk") or t["addr:street"]
        for n in re.split(r"\s*[;,]\s*", t["addr:housenumber"]):
            if n and n not in houses[k].setdefault(street, []):
                houses[k][street].append(n)

    out = []
    for way_id, (key, name) in OSM_WAYS.items():
        hs = {s: sorted(v, key=_num_key) for s, v in sorted(houses[key].items())}
        print(f"  {name}: будинків {sum(len(v) for v in hs.values())}, вулиць {len(streets[key])}")
        out.append({"id": key, "name": name, "osm": f"way/{way_id}", "houses": hs, "streets": sorted(streets[key])})
    OUT.write_text(json.dumps({
        "source": "© учасники OpenStreetMap (ODbL), https://www.openstreetmap.org/copyright",
        "updated": date.today().isoformat(),
        "districts": out,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {OUT}")


if __name__ == "__main__":
    main()
