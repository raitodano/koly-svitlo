// Коли світло? — віджет для iPhone (застосунок Scriptable).
// https://raitodano.github.io/koly-svitlo/  ·  код: https://github.com/raitodano/koly-svitlo
//
// Як поставити:
//  1. Scriptable → «+» → вставте цей текст → назвіть «Коли світло» → ▶ (дозвольте сповіщення).
//  2. На екрані «Додому» додайте віджет Scriptable, торкніться його в режимі редагування:
//     Script — «Коли світло», Parameter — рядок із сайту (Персоналізація → Віджет),
//     напр.  2-ІІ,3-ІІ|бульвар Шевченка, 10
//  3. Натискання на віджет відкриває сайт з вашою адресою.
//
// Сповіщення: на початку помаранчевої півгодинки (перемикання) — приблизно за 30 хв до того,
// як не стане світла. Їх ставить сам скрипт щоразу, коли iOS оновлює віджет.

const SITE = 'https://raitodano.github.io/koly-svitlo/';
const DPEM = 'https://info.dpem.mk.ua/off_graf.html';
const SUBQ = ['1-І', '1-ІІ', '2-І', '2-ІІ', '3-І', '3-ІІ', '4-І', '4-ІІ', '5-І', '5-ІІ', '6-І', '6-ІІ'];
const SLOTS = 48;
const LIVE_EVERY_MIN = 20;          // не частіше читати важку сторінку ДПЕМ (≈1,5 МБ)
const NOTIFY_MAYBE = false;         // true — попереджати й про можливі (смугасті) відключення
const KEY = 'kolysvitlo.param';
const C = {
  lit: new Color('#f4b740'), dark: new Color('#2b2f3a'), sw: new Color('#e8823a'),
  maybe: new Color('#8a7232'), none: new Color('#4a4f5c'), ink: new Color('#1c1a17'), paper: new Color('#f3efe7'),
};

// ---------- параметр: «підчерги|назва» ----------
function readParam() {
  let p = (args.widgetParameter || '').trim();
  if (!p && Keychain.contains(KEY)) p = Keychain.get(KEY);
  if (!p) return null;
  const [q, ...rest] = p.split('|');
  const qids = q.split(/[,\s]+/).map(normQ).filter((x) => SUBQ.includes(x));
  return qids.length ? { qids, title: rest.join('|').trim() || qids.join(', '), raw: p } : null;
}
// «2-II», «2-ii», «2-ІІ» → «2-ІІ» (кирилична І, як на сайті ДПЕМ)
function normQ(s) { return s.trim().toUpperCase().replace(/I/g, 'І'); }

// ---------- час за Києвом ----------
function kyiv(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
/** Дата+слот за київським часом → справжній момент (Date). */
function kyivToDate(date, slot) {
  while (slot >= SLOTS) { date = addDays(date, 1); slot -= SLOTS; } // 24:00 → 00:00 наступного дня
  const guess = new Date(`${date}T${fmt(slot)}:00Z`);
  for (let i = 0; i < 2; i++) { // поправка на зсув Києва від UTC (+2/+3)
    const k = kyiv(guess);
    const diff = (k.date === date ? k.min : k.date > date ? k.min + 1440 : k.min - 1440) - slot * 30;
    guess.setTime(guess.getTime() - diff * 60000);
  }
  return guess;
}
const fmt = (slot) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ---------- графік ----------
function parseRecords(page) {
  const m = page.match(/\brecords\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])\s*;/);
  if (!m) throw new Error('на сторінці ДПЕМ немає графіка');
  const best = {};
  for (const rec of JSON.parse(m[1])) {
    const date = String(rec.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const saved = String(rec.saved_at || '');
    if (best[date] && best[date].saved_at >= saved) continue;
    const vals = (rec.data || []).slice(0, SLOTS * SUBQ.length).map((v) => { const s = String(v ?? '').trim(); const n = s === '' ? NaN : Number(s); return Number.isInteger(n) ? n : null; });
    while (vals.length < SLOTS * SUBQ.length) vals.push(null);
    const rows = {};
    SUBQ.forEach((q, i) => { rows[q] = vals.slice(i * SLOTS, (i + 1) * SLOTS); });
    best[date] = { date, saved_at: saved, rows };
  }
  return Object.values(best);
}

async function loadSchedules() {
  const fm = FileManager.local();
  const file = fm.joinPath(fm.cacheDirectory(), 'kolysvitlo-cache.json');
  let cache = null;
  try { if (fm.fileExists(file)) cache = JSON.parse(fm.readString(file)); } catch (e) { cache = null; }
  const today = kyiv().date;
  const keep = (list) => list.filter((s) => s.date >= addDays(today, -1));
  const merge = (a, b) => {
    const by = {};
    for (const s of [...a, ...b]) if (!by[s.date] || s.saved_at > by[s.date].saved_at) by[s.date] = s;
    return Object.values(by);
  };
  let list = cache ? cache.list : [];
  let at = cache ? cache.at : 0, source = cache ? cache.source : '';
  if (!cache || Date.now() - cache.at > LIVE_EVERY_MIN * 60000) {
    try { // напряму з ДПЕМ (у Scriptable немає обмежень браузера)
      const r = new Request(DPEM); r.timeoutInterval = 25;
      list = merge(list, keep(parseRecords(await r.loadString())));
      at = Date.now(); source = 'ДПЕМ';
    } catch (e) {
      try { // запасний варіант — копія на сайті
        const r = new Request(SITE + 'data.json'); r.timeoutInterval = 20;
        const d = await r.loadJSON();
        list = merge(list, keep(d.schedules || []));
        at = Date.now(); source = 'копія сайту';
      } catch (e2) { /* лишаємо кеш */ }
    }
    try { fm.writeString(file, JSON.stringify({ at, source, list: keep(list) })); } catch (e) { /* ignore */ }
  }
  return { list, at, source };
}

function windowsOf(vals) {
  const out = [];
  if (!vals) return out;
  for (let i = 0; i < SLOTS;) {
    const v = vals[i];
    if (v === 1 || v === 2 || v === 3) {
      let j = i; while (j < SLOTS && [1, 2, 3].includes(vals[j])) j++;
      out.push({ type: 'off', from: i, to: j, sw: v === 1 }); i = j;
    } else if (v === 4) {
      let j = i; while (j < SLOTS && vals[j] === 4) j++;
      out.push({ type: 'maybe', from: i, to: j }); i = j;
    } else i++;
  }
  return out;
}

function statusFor(vals, nowMin) {
  if (!vals || vals.every((v) => v === null)) return { cls: 'unknown', big: 'Немає даних', small: 'графік не опубліковано' };
  const slot = Math.floor(nowMin / 30);
  const ws = windowsOf(vals);
  const cur = ws.find((w) => slot >= w.from && slot < w.to);
  if (cur && cur.type === 'off') return { cls: 'off', big: 'Світла немає', small: `до ${fmt(cur.to)}` };
  if (cur && cur.type === 'maybe') return { cls: 'maybe', big: 'Можливе вимкнення', small: `до ${fmt(cur.to)}` };
  const next = ws.find((w) => w.type === 'off' && w.from > slot);
  if (next) return { cls: 'on', big: 'Світло є', small: `вимкнення о ${fmt(next.from)}` };
  return { cls: 'on', big: 'Світло є', small: 'до кінця доби без вимкнень' };
}

// ---------- сповіщення ----------
async function scheduleNotifications(cfg, list) {
  const ids = [];
  const now = Date.now();
  const today = kyiv().date;
  for (const date of [today, addDays(today, 1)]) {
    const sch = list.find((s) => s.date === date);
    if (!sch) continue;
    for (const q of cfg.qids) {
      for (const w of windowsOf(sch.rows[q])) {
        if (w.type === 'maybe' && !NOTIFY_MAYBE) continue;
        // на початку помаранчевої півгодинки; якщо вікно починається одразу з темної — за 30 хв до неї
        const at = kyivToDate(date, w.type === 'off' && w.sw ? w.from : Math.max(0, w.from - 1));
        if (at.getTime() <= now + 60000) continue;
        const id = `kolysvitlo-${date}-${q}-${w.from}`;
        ids.push(id);
        const n = new Notification();
        n.identifier = id;
        n.threadIdentifier = 'kolysvitlo';
        n.title = w.type === 'off' ? '⚡ Через ~30 хв не буде світла' : 'Можливе відключення світла';
        n.body = `${cfg.title} · ${q}: ${fmt(w.from)}–${fmt(w.to)}`;
        n.openURL = `${SITE}?q=${encodeURIComponent(cfg.title)}`;
        n.sound = 'default';
        n.setTriggerDate(at);
        await n.schedule();
      }
    }
  }
  // прибрати застарілі (графік змінився)
  const pending = await Notification.allPending();
  const stale = pending.filter((n) => n.identifier.startsWith('kolysvitlo-') && !ids.includes(n.identifier)).map((n) => n.identifier);
  if (stale.length) Notification.removePending(stale);
  return ids.length;
}

// ---------- віджет ----------
function barImage(vals, nowMin, w = 300, h = 18) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true;
  const cw = w / SLOTS;
  for (let i = 0; i < SLOTS; i++) {
    const v = vals ? vals[i] : null;
    ctx.setFillColor(v === 0 ? C.lit : v === 2 ? C.dark : v === 1 || v === 3 ? C.sw : v === 4 ? C.maybe : C.none);
    ctx.fillRect(new Rect(i * cw, 0, cw - 0.8, h));
  }
  if (nowMin != null) {
    ctx.setFillColor(Color.white());
    ctx.fillRect(new Rect((nowMin / 1440) * w - 1, 0, 2.5, h));
  }
  return ctx.getImage();
}

function buildWidget(cfg, data) {
  const w = new ListWidget();
  const k = kyiv();
  const fam = config.widgetFamily || 'medium';
  w.url = cfg ? `${SITE}?q=${encodeURIComponent(cfg.title)}` : SITE;
  w.setPadding(12, 14, 12, 14);
  if (!cfg) {
    w.backgroundColor = C.dark;
    const t = w.addText('Коли світло?'); t.font = Font.boldSystemFont(16); t.textColor = C.lit;
    w.addSpacer(4);
    const s = w.addText('Вкажіть Parameter віджета: рядок із сайту (Персоналізація → Віджет).');
    s.font = Font.systemFont(12); s.textColor = Color.white();
    return w;
  }
  const sch = data.list.find((s) => s.date === k.date);
  const sts = cfg.qids.map((q) => statusFor(sch && sch.rows[q], k.min));
  const st = sts.find((s) => s.cls === 'off') || sts.find((s) => s.cls === 'maybe') || sts[0];
  const bg = { on: C.lit, off: C.dark, maybe: C.maybe, unknown: C.none }[st.cls];
  const fg = st.cls === 'on' ? C.ink : Color.white();
  w.backgroundColor = bg;

  if (fam.startsWith('accessory')) { // віджет на екрані блокування
    const t = w.addText(`${st.big} · ${st.small}`); t.font = Font.semiboldSystemFont(13);
    return w;
  }
  const a = w.addText(cfg.title.toUpperCase()); a.font = Font.semiboldSystemFont(11); a.textColor = fg; a.textOpacity = 0.8; a.lineLimit = 1;
  w.addSpacer(2);
  const b = w.addText(st.big); b.font = Font.boldSystemFont(fam === 'small' ? 22 : 26); b.textColor = fg; b.minimumScaleFactor = 0.6; b.lineLimit = 1;
  const s = w.addText(`${st.small} · ${cfg.qids.join(', ')}`); s.font = Font.systemFont(13); s.textColor = fg; s.textOpacity = 0.9; s.lineLimit = 2;
  w.addSpacer();
  if (sch) {
    const img = w.addImage(barImage(sch.rows[cfg.qids[0]], k.min, fam === 'small' ? 150 : 300, 14));
    img.imageSize = new Size(fam === 'small' ? 130 : 290, 12);
  }
  w.addSpacer(4);
  const when = data.at ? new Date(data.at) : null;
  const f = w.addText(when ? `${data.source || ''} · ${when.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}` : 'немає з’єднання');
  f.font = Font.systemFont(10); f.textColor = fg; f.textOpacity = 0.65;
  // оновитися на початку наступної півгодинки
  const next = kyivToDate(k.date, Math.floor(k.min / 30) + 1);
  w.refreshAfterDate = new Date(Math.max(next.getTime() + 30000, Date.now() + 5 * 60000));
  return w;
}

// ---------- запуск ----------
let cfg = readParam();
if (config.runsInApp && !args.widgetParameter) {
  const al = new Alert();
  al.title = 'Коли світло?';
  al.message = cfg ? `Зараз: ${cfg.title} (${cfg.qids.join(', ')}).\nВставте інший рядок із сайту або залиште як є.` : 'Вставте рядок із сайту: Персоналізація → Віджет (напр. «2-ІІ,3-ІІ|бульвар Шевченка, 10»).';
  al.addTextField('2-ІІ,3-ІІ|бульвар Шевченка, 10', cfg ? cfg.raw : '');
  al.addAction('Зберегти');
  al.addCancelAction('Скасувати');
  if (await al.present() === 0) {
    const v = al.textFieldValue(0).trim();
    if (v) { Keychain.set(KEY, v); cfg = readParam(); }
  }
}
const data = await loadSchedules();
if (cfg) { try { await scheduleNotifications(cfg, data.list); } catch (e) { console.log(`сповіщення: ${e}`); } }
const widget = buildWidget(cfg, data);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
