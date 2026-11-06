"""Збирає статичну версію сайту для GitHub Pages: static/ + свіжий data.json.

Запуск:  py build_static.py [папка]     (за замовчуванням site/)
GitHub Actions (.github/workflows/pages.yml) робить це за розкладом і публікує результат.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import dpem  # noqa: E402

DATA_HOOK = '<script src="app.js"></script>'
CSS_HOOK = 'href="style.css"'


def build(out: Path) -> dict:
    data = dpem.load()
    data["stale"] = False
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "static", out)
    (out / "data.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    index = out / "index.html"
    html = index.read_text(encoding="utf-8")
    if DATA_HOOK not in html or CSS_HOOK not in html:
        raise RuntimeError("index.html: не знайдено підключення app.js / style.css")
    # GitHub Pages кешує файли на 10 хв — версія в адресі, щоб після оновлення сайту
    # браузер не змішував новий index.html зі старим app.js
    ver = hashlib.sha1(b"".join((out / f).read_bytes() for f in ("app.js", "style.css"))).hexdigest()[:10]
    html = html.replace(CSS_HOOK, f'href="style.css?v={ver}"')
    html = html.replace(
        DATA_HOOK,
        '<script>window.GPV_DATA_URL = "data.json";</script>\n  ' + f'<script src="app.js?v={ver}"></script>',
    )
    index.write_text(html, encoding="utf-8")
    return data


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "site")
    d = build(target)
    print(f"{target}/: {len(d['schedules'])} дат (остання {d['schedules'][0]['date']}, "
          f"оновлено на сайті {d['schedules'][0]['saved_at']}), {len(d['queues'])} підчерг")
