'use strict';

/* Коли світло? — пошук черги ГПВ за адресою.
   Дані: /api/data (локальний server.py / KolySvitlo.exe) або data.json (GitHub Pages,
   збирає build_static.py). Як усе влаштовано — див. КАК_ЭТО_РАБОТАЕТ.md. */

const DATA_URL = window.GPV_DATA_URL || '/api/data';
const STATIC_MODE = Boolean(window.GPV_DATA_URL);
const STALE_AFTER_MIN = 90;
const TZ = 'Europe/Kyiv';
const SLOTS = 48;
const REFRESH_MS = 5 * 60 * 1000;
const MAX_CARDS = 30;
const MINE_KEY = 'gpv.mine';
const STATE_LABEL = {
  0: 'світло є', 1: 'перемикання (вимкнення)', 2: 'світла немає',
  3: 'перемикання (увімкнення)', 4: 'можливе відключення',
};
const EXAMPLES = ['Шев 10', 'Незалежності 20', 'Європейська 5А', 'Молодіжна 7', 'Степова', 'Костянтинівка Шевченка'];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { data: null, index: [], date: null, query: '', order: {}, cards: [], mine: loadMine(), addOpen: false };

/* ===================== нормалізація тексту ===================== */

const FOLD = { 'і': 'и', 'ї': 'и', 'ы': 'и', 'й': 'и', 'є': 'е', 'э': 'е', 'ё': 'е', 'ґ': 'г', 'ь': '', 'ъ': '' };
const LAT = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'и', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', v: 'в', g: 'г', d: 'д' };

function fold(s) {
  return String(s).toLowerCase().replace(/[’'ʼ`]/g, '').replace(/[іїыйєэёґьъ]/g, (c) => FOLD[c]);
}
function words(s) { return fold(s).match(/[а-яa-z0-9]+/g) || []; }

const STOP = new Set(['вул', 'вулиця', 'ул', 'улица', 'бул', 'бульв', 'бульвар', 'бр', 'пр', 'прт', 'пркт', 'просп',
  'проспект', 'пров', 'провулок', 'пер', 'переулок', 'пл', 'площа', 'площадь', 'туп', 'тупик', 'мкр', 'смт', 'село',
  'місто', 'город', 'буд', 'будинок', 'дом', 'кв', 'квартира', 'номер'].map(fold));

/* Російські основи → українські (людина може писати російською). */
const SYN = [
  ['независим', 'незалежн'], ['южноукр', 'південноукр'], ['энергостро', 'енергобуд'], ['гидростро', 'гідробуд'],
  ['строит', 'будів'], ['цветоч', 'квіткові'], ['мечт', 'мрій'], ['казацк', 'козацьк'], ['южн', 'південн'],
  ['пригородн', 'приміськ'], ['уютн', 'затишн'], ['прибугск', 'прибузьк'], ['рыбацк', 'рибальськ'],
  ['восточн', 'східн'], ['побед', 'перемог'], ['николаевск', 'миколаївськ'], ['полев', 'польов'],
  ['владимир', 'володимир'], ['константинов', 'костянтинів'], ['родник', 'джерельн'], ['промышлен', 'промислов'],
  ['степн', 'степов'], ['школьн', 'шкільн'], ['солнечн', 'сонячн'], ['творческ', 'творч'], ['молодежн', 'молодіжн'],
  ['героев', 'героїв'], ['спасск', 'спаськ'], ['привольн', 'привільн'], ['несокрушим', 'незламн'],
  ['александров', 'олександрів'], ['прибужье', 'прибужжя'],
].map(([a, b]) => [fold(a), fold(b)]);

function alternatives(q) {
  const out = [q];
  for (const [ru, ua] of SYN) if (q.startsWith(ru) && !out.includes(ua)) out.push(ua);
  return out;
}

function normHouse(s) {
  let h = String(s).toLowerCase().replace(/№|\s/g, '');
  h = h.replace(/[a-z]/g, (c) => LAT[c] || c).replace(/[іїєґ]/g, (c) => FOLD[c]).replace(/–/g, '-');
  return h.replace(/(\d)-(?=[а-я])/g, '$1'); // 54-б → 54б
}
const houseBase = (h) => (h.match(/^\d+/) || [''])[0];

function streetKey(name) { return words(name).map((w) => w.slice(0, 5)).join(' '); }

/* ===================== нечітке порівняння слів ===================== */

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Наскільки слово запиту q схоже на слово w з адреси (0 — не схоже). */
function wordScore(q, w, abbr) {
  if (w === q) return 4;
  if (w.startsWith(q)) return q.length >= 3 || w.length <= 3 ? 3 : 2;
  if (w.length === 1) return abbr && q[0] === w ? 1 : 0;   // ініціал: «Л. Українки» (але не «з»)
  if (abbr && w.length >= 3 && q.startsWith(w)) return 2;  // скорочення: «Набер. енергетиків»
  const tol = q.length <= 3 ? 0 : q.length <= 5 ? 1 : 2;
  if (tol && q[0] === w[0]) { // «Шевченко» ≈ «Шевченка», але «Паркова» ≠ «Балкова»
    const lo = Math.max(1, q.length - tol), hi = Math.min(w.length, q.length + tol);
    for (let k = lo; k <= hi; k++) if (lev(q, w.slice(0, k)) <= tol) return 1.5;
  }
  if (q.length >= 4 && w.includes(q)) return 1;
  return 0;
}

/* ===================== індекс і пошук ===================== */

function buildIndex(data) {
  const idx = [];
  for (const q of data.queues) {
    q.rows.forEach((row) => {
      for (const e of row.entries) {
        const nameWords = [];
        for (const piece of e.name.split(/\s+/)) {
          const ws = words(piece);
          ws.forEach((w, i) => nameWords.push({ w, abbr: i === ws.length - 1 && piece.endsWith('.') }));
        }
        idx.push({
          qid: q.id, row, entry: e, nameWords,
          locWords: words(e.loc).filter((w) => w.length > 1 && !STOP.has(w)),
          key: `${e.loc}|${streetKey(e.name)}`,
        });
      }
    });
  }
  return idx;
}

function parseQuery(text) {
  let house = null, rest = text;
  const m = text.match(/(\d+)(?:\s*[-–]?\s*([a-zа-яєіїґ])(?![a-zа-яєіїґ]))?(?:\s*\/\s*(\d+[a-zа-яєіїґ]?))?(?:\s*[-–]\s*(\d+)(?!\d))?/i);
  if (m) {
    house = normHouse(m[0]);
    rest = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  }
  return { house, words: words(rest).filter((w) => w.length > 1 && !STOP.has(w)) };
}

function matchHouse(houses, q) {
  let close = null;
  for (const raw of houses) {
    const h = normHouse(raw);
    if (h === q) return { level: 'exact', house: raw };
    const r = h.match(/^(\d+)-(\d+)$/);
    if (r && /^\d+$/.test(q)) {
      const n = +q, a = +r[1], b = +r[2];
      if (b > a && b - a <= 20 && n >= a && n <= b) return { level: 'exact', house: raw };
    }
    if (!close && houseBase(h) && houseBase(h) === houseBase(q)) close = { level: 'close', house: raw };
  }
  return close;
}

const LEVEL_BONUS = { exact: 10, street: 5, close: 2, object: 1, any: 0 };

function wordsMatch(qw, ws) {
  return qw.every((q) => alternatives(q).some((a) => ws.some((w) => wordScore(a, w, false) > 0)));
}

function search(text) {
  const { house, words: qw } = parseQuery(text);
  if (!qw.length) return { house, words: qw, cards: [], misses: [], noWords: true };

  const hits = [], locOnly = [], misses = new Map();
  for (const it of state.index) {
    let score = 0, nameHit = false, ok = true, strong = true;
    for (const q of qw) {
      let bn = 0, bl = 0;
      for (const a of alternatives(q)) {
        for (const nw of it.nameWords) bn = Math.max(bn, wordScore(a, nw.w, nw.abbr));
        for (const lw of it.locWords) bl = Math.max(bl, wordScore(a, lw, false));
      }
      if (bn > 0 && bn >= bl) { score += bn; nameHit = true; if (bn < 2) strong = false; } else if (bl > 0) { score += bl * 0.5; strong = false; } else { ok = false; break; }
    }
    if (!ok) continue;

    let level = 'any', matched = null;
    if (house) {
      if (!it.entry.houses.length) level = it.entry.kind === 'street' ? 'street' : 'object';
      else {
        const hm = matchHouse(it.entry.houses, house);
        if (!hm) {
          // вулицю знайдено, а такого будинку в переліках немає — підкажемо, які є
          if (strong && it.entry.kind === 'street') {
            if (!misses.has(it.key)) misses.set(it.key, { key: it.key, hits: [], houses: new Set() });
            const ms = misses.get(it.key);
            ms.hits.push(it);
            it.entry.houses.forEach((x) => ms.houses.add(x));
          }
          continue;
        }
        ({ level, house: matched } = hm);
      }
    }
    const hit = { ...it, level, matched, score: score + LEVEL_BONUS[level] - (it.entry.kind === 'other' ? 0.5 : 0) };
    (nameHit ? hits : locOnly).push(hit);
  }

  const groups = new Map();
  for (const h of hits.length ? hits : locOnly) {
    const gk = `${h.key}|${house ? h.level : ''}|${h.level === 'close' ? normHouse(h.matched) : ''}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { id: gk, hits: [], score: 0, level: h.level, matched: h.matched }));
    g.hits.push(h);
    g.score = Math.max(g.score, h.score);
  }
  const cards = [...groups.values()].sort((a, b) => b.score - a.score || cardTitle(a).localeCompare(cardTitle(b), 'uk'));
  const found = new Set(cards.filter((c) => c.level === 'exact' || c.level === 'close').map((c) => c.hits[0].key));
  const missList = [...misses.values()].filter((m) => !found.has(m.key));
  return { house, words: qw, cards: cards.slice(0, MAX_CARDS), total: cards.length, misses: missList, locOnly: !hits.length && locOnly.length > 0 };
}

/** Найкращий варіант написання назви серед збігів (з типом вулиці, без скорочень). */
function displayEntry(hits) {
  const rank = (e) => (e.kind === 'street' ? 2 : 0) + (e.type ? 1 : 0) + (e.name.includes('.') ? -2 : 0) + e.name.length / 100;
  return hits.map((h) => h.entry).sort((a, b) => rank(b) - rank(a))[0];
}
function cardTitle(g) {
  const e = displayEntry(g.hits);
  return `${e.type ? e.type + ' ' : ''}${e.name}`;
}
function sortHouses(list) {
  return [...list].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b, 'uk'));
}

/* ===================== «Мої адреси» (зберігаються в цьому браузері) ===================== */

function loadMine() {
  try {
    const v = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((m) => m && (m.kind === 'found' || m.kind === 'manual')) : [];
  } catch { return []; }
}
function saveMine() {
  try { localStorage.setItem(MINE_KEY, JSON.stringify(state.mine)); } catch { /* приватний режим */ }
}
const uid = () => Math.random().toString(36).slice(2, 10);
const savedFound = (id) => state.mine.find((m) => m.kind === 'found' && m.id === id);

/* ===================== час і графік ===================== */

function kyivNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, hhmm: `${p.hour}:${p.minute}` };
}
const fmt = (slot) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
function dur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} год${m ? ` ${m} хв` : ''}` : `${m} хв`;
}
const durShort = (min) => `${Math.floor(min / 60)}${min % 60 ? ',5' : ''} год`; // слоти по 30 хв
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const ddmm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** Вікна відключень: суцільні відрізки 1/2/3 (з перемиканням) та 4 (можливе). */
function windowsOf(vals) {
  const out = [];
  if (!vals) return out;
  for (let i = 0; i < SLOTS;) {
    const v = vals[i];
    if (v === 1 || v === 2 || v === 3) {
      let j = i, cs = -1, ce = -1;
      while (j < SLOTS && (vals[j] === 1 || vals[j] === 2 || vals[j] === 3)) {
        if (vals[j] === 2) { if (cs < 0) cs = j; ce = j + 1; }
        j++;
      }
      out.push({ type: 'off', from: i, to: j, coreFrom: cs, coreTo: ce });
      i = j;
    } else if (v === 4) {
      let j = i;
      while (j < SLOTS && vals[j] === 4) j++;
      out.push({ type: 'maybe', from: i, to: j });
      i = j;
    } else i++;
  }
  return out;
}
const offMinutes = (vals) => windowsOf(vals).filter((w) => w.type === 'off').reduce((s, w) => s + (w.to - w.from) * 30, 0);

function schedule(date) { return state.data?.schedules.find((s) => s.date === date) || null; }
function rowVals(date, qid) { return schedule(date)?.rows?.[qid] || null; }

/** Стан на зараз: cls — для кольору, text — розгорнуто, big/small — для центру циферблата. */
function statusFor(vals, nowMin) {
  if (!vals || vals.every((v) => v === null)) return { cls: 'unknown', text: 'Немає даних графіка', big: 'Немає даних', small: '' };
  const slot = Math.floor(nowMin / 30);
  const ws = windowsOf(vals);
  const cur = ws.find((w) => slot >= w.from && slot < w.to);
  const nextOff = ws.find((w) => w.type === 'off' && w.from > slot);
  if (cur?.type === 'off') return { cls: 'off', text: `Зараз світла немає · орієнтовно до ${fmt(cur.to)}`, big: 'Світла немає', small: `до ${fmt(cur.to)}` };
  if (cur?.type === 'maybe') return { cls: 'maybe', text: `Зараз можливе відключення · до ${fmt(cur.to)}`, big: 'Можливе', small: `до ${fmt(cur.to)}` };
  if (nextOff) {
    return { cls: 'on', text: `Зараз світло є · відключення о ${fmt(nextOff.from)} (через ${dur(nextOff.from * 30 - nowMin)})`, big: 'Світло є', small: `вимкн. о ${fmt(nextOff.from)}` };
  }
  const nextMaybe = ws.find((w) => w.type === 'maybe' && w.from > slot);
  if (nextMaybe) return { cls: 'on', text: `Зараз світло є · можливе відключення о ${fmt(nextMaybe.from)}`, big: 'Світло є', small: `можл. о ${fmt(nextMaybe.from)}` };
  return { cls: 'on', text: 'Зараз світло є · до кінця доби відключень не заплановано', big: 'Світло є', small: 'до кінця доби' };
}

/* ===================== циферблат 24 год ===================== */

const RING = { c: 90, r0: 60, r1: 84 };

function polar(r, deg) {
  const t = (deg - 90) * Math.PI / 180;
  return `${(RING.c + r * Math.cos(t)).toFixed(2)} ${(RING.c + r * Math.sin(t)).toFixed(2)}`;
}
function sector(a0, a1) {
  const { r0, r1 } = RING;
  return `M${polar(r1, a0)}A${r1} ${r1} 0 0 1 ${polar(r1, a1)}L${polar(r0, a1)}A${r0} ${r0} 0 0 0 ${polar(r0, a0)}Z`;
}
function handAngle(minutes) { return (minutes / 1440) * 360; }

function ringHtml(vals, date, qid) {
  const { c, r0, r1 } = RING;
  const now = kyivNow();
  const today = date === now.date;
  let segs = '';
  for (let i = 0; i < SLOTS; i++) {
    const v = vals ? vals[i] : null;
    segs += `<path class="seg v${v ?? 'x'}" d="${sector(i * 7.5, (i + 1) * 7.5)}"><title>${fmt(i)}–${fmt(i + 1)} · ${esc(STATE_LABEL[v] ?? 'немає даних')}</title></path>`;
  }
  const hours = [0, 6, 12, 18].map((h) => `<text class="hr" x="${polar(r0 - 9, h * 15).split(' ')[0]}" y="${polar(r0 - 9, h * 15).split(' ')[1]}">${h}</text>`).join('');
  const hand = today
    ? `<g class="hand" transform="rotate(${handAngle(now.minutes).toFixed(1)} ${c} ${c})"><line x1="${c}" y1="${c - r0 + 3}" x2="${c}" y2="${c - r1 - 5}"/><circle cx="${c}" cy="${c - r1 - 6}" r="3"/></g>`
    : '';
  let center;
  if (today) {
    const st = statusFor(vals, now.minutes);
    center = `<div class="ring-center ${st.cls}" data-ring="${esc(qid)}"><b>${esc(st.big)}</b><span>${esc(st.small)}</span></div>`;
  } else {
    const off = offMinutes(vals);
    center = vals
      ? `<div class="ring-center"><b>${off ? esc(dur(off)) : 'Без вимкнень'}</b><span>${off ? 'без світла за добу' : ddmm(date)}</span></div>`
      : '<div class="ring-center"><b>—</b><span>немає графіка</span></div>';
  }
  return `<div class="ring"><svg viewBox="0 0 180 180" role="img" aria-label="Графік на добу ${esc(qid)}">${segs}${hours}${hand}</svg>${center}</div>`;
}

/* ===================== рендер ===================== */

function winsHtml(vals) {
  if (!vals) return '<ul class="wins"><li>Графік на цю дату не опубліковано</li></ul>';
  const ws = windowsOf(vals);
  if (!ws.length) return '<ul class="wins"><li class="none">Відключень не заплановано</li></ul>';
  return `<ul class="wins">${ws.map((w) => {
    if (w.type === 'maybe') {
      return `<li class="maybe"><b>${fmt(w.from)}–${fmt(w.to)}</b><span class="tag2">можливе відключення</span></li>`;
    }
    const core = w.coreFrom >= 0 && (w.coreFrom !== w.from || w.coreTo !== w.to)
      ? `<small>повністю без світла ${fmt(w.coreFrom)}–${fmt(w.coreTo)}, ще до 30 хв — перемикання на початку й наприкінці</small>` : '';
    return `<li class="off"><b>${fmt(w.from)}–${fmt(w.to)}</b><span class="tag2">без світла</span>${core}</li>`;
  }).join('')}</ul>`;
}

function rowsLabel(rows) {
  const subs = [...new Set(rows.map((r) => r.substation))].join(', ');
  const feeders = [...new Set(rows.map((r) => r.feeder))].join(', ');
  return `${subs} · фідер ${feeders}${rows.some((r) => r.partial) ? ' · частково' : ''}`;
}

function housesHtml(hits, query) {
  const all = [];
  for (const h of hits) for (const x of h.entry.houses) if (!all.includes(x)) all.push(x);
  if (!all.length) return '<div class="houses">Номери будинків не вказані — у переліку вулиця загалом</div>';
  return `<div class="houses">Будинки: ${sortHouses(all).map((x) => (query && normHouse(x) === query ? `<span class="hl">${esc(x)}</span>` : `<b>${esc(x)}</b>`)).join(', ')}</div>`;
}

/** Блок однієї підчерги: циферблат + стан + вікна відключень. */
function sqHtml(qid, sub, extra) {
  const vals = rowVals(state.date, qid);
  const now = kyivNow();
  const st = state.date === now.date ? statusFor(vals, now.minutes) : null;
  return `<div class="sq">
    ${ringHtml(vals, state.date, qid)}
    <div class="sq-info">
      <div class="sq-top"><span class="tag">${esc(qid)}</span><span class="sq-title">черга ${esc(qid.split('-')[0])}${sub ? ` · ${esc(sub)}` : ''}</span></div>
      ${st ? `<div class="status ${st.cls}" data-qid="${esc(qid)}">${esc(st.text)}</div>` : ''}
      ${winsHtml(vals)}
      ${extra || ''}
    </div>
  </div>`;
}

function renderCard(g, house, opts = {}) {
  const e = displayEntry(g.hits);
  let title = esc(`${e.type ? e.type + ' ' : ''}${e.name}`);
  const flags = [];
  if (house && g.level === 'exact') title += `, ${esc(g.matched)}`;
  if (g.level === 'close') flags.push(`<span class="flag warn">Будинку «${esc(house)}» у переліку немає, знайдено схожий номер: ${esc(g.matched)}</span>`);
  if (g.level === 'street') flags.push('<span class="flag">Номери будинків не вказані — у переліку вулиця загалом (може бути частково)</span>');
  if (g.level === 'object') flags.push('<span class="flag">Згадка в переліку без номера будинку</span>');
  const notes = [...new Set(g.hits.map((h) => h.entry.note).filter(Boolean))];
  if (notes.length) flags.push(`<span class="flag">У переліку: «${esc(notes.join(', '))}»</span>`);

  const bySq = new Map();
  for (const h of g.hits) {
    if (!bySq.has(h.qid)) bySq.set(h.qid, []);
    bySq.get(h.qid).push(h);
  }
  const sqs = [...bySq.keys()].sort((a, b) => state.order[a] - state.order[b]);
  if (sqs.length > 1) flags.push(`<span class="flag">Адреса є в ${sqs.length} підчергах — будинок може живитися від кількох ліній, діють обидва графіки</span>`);

  const saved = opts.savedUid ? { uid: opts.savedUid } : savedFound(g.id);
  const pin = opts.savedUid
    ? `<button type="button" class="pin" aria-pressed="true" data-remove="${esc(opts.savedUid)}" title="Прибрати з «Моїх адрес»">★ Моя адреса</button>`
    : `<button type="button" class="pin" aria-pressed="${saved ? 'true' : 'false'}" data-save="${esc(g.id)}">${saved ? '★ Збережено' : '☆ Зберегти'}</button>`;

  const sections = sqs.map((qid) => {
    const hs = bySq.get(qid);
    const rows = [...new Set(hs.map((h) => h.row))];
    const raw = rows.map((r) => esc(r.text)).join('\n\n');
    const extra = `${!house || g.level === 'close' ? housesHtml(hs, house) : ''}
      <details class="raw-box"><summary>Повний перелік адрес цієї лінії</summary><div class="raw">${raw}</div></details>`;
    return sqHtml(qid, rowsLabel(rows), extra);
  }).join('');

  return `<article class="card">
    <div class="card-head"><h3>${title}</h3>${pin}<div class="loc">${esc(e.loc)}</div>${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}</div>
    ${sections}
  </article>`;
}

function renderManual(m) {
  return `<article class="card">
    <div class="card-head"><h3>${esc(m.title)}</h3>
      <button type="button" class="pin" aria-pressed="true" data-remove="${esc(m.uid)}" title="Прибрати з «Моїх адрес»">★ Моя адреса</button>
      <div class="loc">${esc(m.loc || 'населений пункт не вказано')}</div>
      <div class="flags"><span class="flag warn">Додано вручну: підчергу ${esc(m.qid)} вказали ви — в переліках ДПЕМ цієї адреси немає</span></div>
    </div>
    ${sqHtml(m.qid, 'вказано вручну', '')}
  </article>`;
}

function renderMineCards() {
  return state.mine.map((m) => {
    if (m.kind === 'manual') return renderManual(m);
    const g = search(m.q).cards.find((c) => c.id === m.id);
    if (!g) {
      return `<div class="miss"><b>${esc(m.title)}</b>: цієї адреси більше немає в переліках ДПЕМ (запит «${esc(m.q)}»).
        <button type="button" class="pin" data-remove="${esc(m.uid)}">Прибрати</button></div>`;
    }
    return renderCard(g, parseQuery(m.q).house, { savedUid: m.uid });
  }).join('');
}

function adderHtml(prefill, open) {
  const opts = state.data.subqueues.map((q) => `<option value="${esc(q)}">${esc(q)}</option>`).join('');
  return `<details class="adder"${open ? ' open' : ''}>
    <summary>＋ Додати адресу вручну</summary>
    <p>Якщо вашої адреси немає в переліках ДПЕМ, але ви знаєте свою підчергу (з рахунку, Viber/Telegram-бота ДПЕМ
      або від диспетчера) — додайте її, і графік показуватиметься в «Моїх адресах». Зберігається лише в цьому браузері.</p>
    <form id="add-form" autocomplete="off">
      <label>Адреса<input name="title" required maxlength="80" placeholder="напр. Островського 7а" value="${esc(prefill)}"></label>
      <label>Населений пункт<input name="loc" maxlength="60" placeholder="необов'язково"></label>
      <label>Підчерга<select name="qid" required><option value="">—</option>${opts}</select></label>
      <button type="submit">Зберегти</button>
    </form>
  </details>`;
}

function missesHtml(misses, house) {
  return misses.map((m) => {
    const e = displayEntry(m.hits);
    return `<div class="miss"><b>${esc(`${e.type ? e.type + ' ' : ''}${e.name}`)}</b> (${esc(e.loc)}):
      будинку <b>${esc(house)}</b> у переліках ГПВ немає. Є: ${esc(sortHouses(m.houses).join(', '))}.</div>`;
  }).join('');
}

function renderResults() {
  const box = $('#results');
  if (!state.data) return;
  const q = state.query.trim();
  state.cards = [];

  if (!q) {
    const mine = state.mine.length
      ? `<div class="sec-title">Мої адреси</div>${renderMineCards()}`
      : '';
    box.innerHTML = `${mine}
      <div class="hint"><p>${state.mine.length ? 'Шукайте іншу адресу:' : 'Почніть вводити вулицю й номер будинку — можна скорочено, наприклад «Шев 10». Знайдену адресу можна зберегти ☆, і вона показуватиметься тут одразу.'}</p>
      <div class="examples">${EXAMPLES.map((x) => `<button type="button" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>
      ${adderHtml('', state.addOpen)}`;
    return;
  }

  const res = search(q);
  state.cards = res.cards;
  const manual = res.words.length
    ? state.mine.filter((m) => m.kind === 'manual' && wordsMatch(res.words, words(`${m.title} ${m.loc || ''}`)))
    : [];
  const parts = [];
  parts.push(...manual.map(renderManual));
  if (res.noWords) {
    parts.push('<div class="hint"><p>Додайте назву вулиці (хоча б перші літери), наприклад «Шев 10».</p></div>');
  } else {
    parts.push(missesHtml(res.misses, res.house));
    if (res.locOnly) parts.push('<div class="hint"><p>Вулицю не вказано — показано всі адреси населеного пункту.</p></div>');
    if (res.total > res.cards.length) parts.push(`<div class="hint"><p>Показано ${res.cards.length} з ${res.total} збігів — уточніть запит.</p></div>`);
    parts.push(...res.cards.map((g) => renderCard(g, res.house)));
    if (!res.cards.length && !manual.length && !res.misses.length) {
      parts.push(`<div class="hint"><p>За запитом «${esc(q)}» у переліках ДПЕМ нічого немає.</p>
        <p>Спробуйте коротше (перші 3–4 літери вулиці) або без номера. Якщо адреси немає в переліках, а підчергу ви знаєте — додайте її вручну нижче.</p></div>`);
    }
  }
  const nothing = !res.cards.length && !manual.length;
  parts.push(adderHtml(nothing ? q : '', state.addOpen || nothing));
  box.innerHTML = parts.join('');
}

function renderDays() {
  const now = kyivNow();
  const dates = state.data.schedules.map((s) => s.date);
  const shown = dates.filter((d) => d >= addDays(now.date, -1)).slice(0, 4);
  if (!shown.length) shown.push(...dates.slice(0, 2));
  if (!shown.includes(state.date)) shown.push(state.date);
  shown.sort();
  const label = (d) => {
    if (d === now.date) return 'Сьогодні';
    if (d === addDays(now.date, 1)) return 'Завтра';
    if (d === addDays(now.date, -1)) return 'Вчора';
    return new Intl.DateTimeFormat('uk-UA', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'));
  };
  $('#days').innerHTML = shown.map((d) =>
    `<button type="button" role="tab" data-date="${d}" aria-selected="${d === state.date}">${label(d)}<small>${ddmm(d)}</small></button>`,
  ).join('');
}

function renderOverview() {
  const sch = schedule(state.date);
  $('#overview-title').textContent = `Усі черги · ${ddmm(state.date)}`;
  if (!sch) { $('#overview').innerHTML = '<div class="hm"><div class="empty">Графік на цю дату не опубліковано.</div></div>'; return; }
  const hit = new Set(state.cards.flatMap((g) => g.hits.map((h) => h.qid)));
  const now = kyivNow();
  const rows = state.data.subqueues.map((qid) => {
    const vals = sch.rows[qid];
    const ws = windowsOf(vals);
    const off = ws.filter((w) => w.type === 'off').map((w) => `${fmt(w.from)}–${fmt(w.to)}`);
    const maybe = ws.filter((w) => w.type === 'maybe').map((w) => `${fmt(w.from)}–${fmt(w.to)}`);
    const mins = offMinutes(vals);
    const cells = vals.map((v, i) => `<i class="c v${v ?? 'x'}" title="${esc(qid)} · ${fmt(i)}–${fmt(i + 1)} · ${esc(STATE_LABEL[v] ?? 'немає даних')}"></i>`).join('');
    const times = [off.length ? off.join(', ') : 'без відключень', maybe.length ? `можливо ${maybe.join(', ')}` : ''].filter(Boolean).join(' · ');
    return `<div class="hm-row${mins ? '' : ' dim'}${hit.has(qid) ? ' hit' : ''}">
      <span class="hm-lab">${esc(qid)}</span><div class="hm-cells">${cells}</div><span class="hm-sum">${mins ? esc(durShort(mins)) : '—'}</span>
      <div class="hm-times">${esc(times)}</div></div>`;
  }).join('');
  const nowLine = state.date === now.date ? `<div class="hm-now" style="--now:${(now.minutes / 1440).toFixed(4)}"></div>` : '';
  $('#overview').innerHTML = `<div class="hm">
    <div class="hm-hours"><span></span><div><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div><span class="sumh" title="без світла за добу">вимк.</span></div>
    ${rows}${nowLine}</div>`;
}

function renderMeta() {
  const d = state.data;
  const sch = schedule(state.date);
  const t = (iso) => new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const parts = [];
  if (sch?.saved_at) parts.push(`Графік на ${ddmm(sch.date)} оновлено на сайті ДПЕМ ${ddmm(sch.saved_at.slice(0, 10))} о ${sch.saved_at.slice(11, 16)}`);
  if (d.fetched_at) parts.push(`дані отримано ${t(d.fetched_at)}`);
  $('#meta').innerHTML = `${esc(parts.join(' · '))} · <button type="button" id="refresh">оновити</button>`;
  const n = $('#notice');
  const ageMin = d.fetched_at ? (Date.now() - Date.parse(d.fetched_at)) / 60000 : 0;
  if (d.stale && d.error) {
    n.hidden = false;
    n.innerHTML = 'Не вдалося оновити дані з сайту ДПЕМ — показано збережену копію. <button type="button" id="retry">Спробувати ще</button>';
  } else if (ageMin > STALE_AFTER_MIN) {
    n.hidden = false;
    n.innerHTML = `Дані могли застаріти: останнє оновлення ${esc(t(d.fetched_at))}. Звірте з <a href="https://info.dpem.mk.ua/off_graf.html" target="_blank" rel="noopener">сайтом ДПЕМ</a>.`;
  } else n.hidden = true;
}

function renderAll() {
  renderDays();
  renderResults();
  renderOverview();
  renderMeta();
  tickClock();
}

function tickClock() { $('#clock').textContent = kyivNow().hhmm; }

/** Щопівхвилини оновлюємо «зараз» без повного перерендеру (щоб не закривались розгорнуті списки). */
function tick() {
  tickClock();
  if (!state.data) return;
  const now = kyivNow();
  if (state.date !== now.date) return;
  const ang = handAngle(now.minutes).toFixed(1);
  document.querySelectorAll('.ring .hand').forEach((h) => h.setAttribute('transform', `rotate(${ang} ${RING.c} ${RING.c})`));
  document.querySelectorAll('.ring-center[data-ring]').forEach((el) => {
    const st = statusFor(rowVals(state.date, el.dataset.ring), now.minutes);
    el.className = `ring-center ${st.cls}`;
    el.innerHTML = `<b>${esc(st.big)}</b><span>${esc(st.small)}</span>`;
  });
  document.querySelectorAll('.status[data-qid]').forEach((el) => {
    const st = statusFor(rowVals(state.date, el.dataset.qid), now.minutes);
    el.className = `status ${st.cls}`;
    el.textContent = st.text;
  });
  $('.hm-now')?.style.setProperty('--now', (now.minutes / 1440).toFixed(4));
}

/* ===================== дані ===================== */

async function load(force = false) {
  if (!state.data) $('#results').innerHTML = '<div class="skeleton"></div>';
  try {
    const url = STATIC_MODE ? `${DATA_URL}?t=${Date.now()}` : `${DATA_URL}${force ? '?refresh=1' : ''}`;
    const r = await fetch(url, { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok || !d.schedules) throw new Error(d.error || `HTTP ${r.status}`);
    const firstLoad = !state.data;
    const sig = (x) => JSON.stringify([x.schedules.map((s) => s.date + s.saved_at), x.queues.map((q) => q.rows.map((w) => w.text)), x.stale]);
    if (!firstLoad && !force && sig(d) === sig(state.data)) { state.data.fetched_at = d.fetched_at; renderMeta(); return; }
    state.data = d;
    state.order = Object.fromEntries(d.subqueues.map((q, i) => [q, i]));
    state.index = buildIndex(d);
    const dates = d.schedules.map((s) => s.date);
    const today = kyivNow().date;
    if (firstLoad || !dates.includes(state.date)) state.date = dates.includes(today) ? today : dates[0];
    renderAll();
  } catch (err) {
    if (!state.data) {
      $('#results').innerHTML = `<div class="notice">Не вдалося завантажити графіки: ${esc(err.message)}
        <button type="button" id="retry">Спробувати ще</button></div>`;
    }
  }
}

/* ===================== події ===================== */

let debounce;
const input = $('#q');
function setQuery(v) {
  state.query = v;
  try { localStorage.setItem('gpv.q', v); } catch { /* приватний режим */ }
  renderResults();
  renderOverview();
}
input.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => setQuery(input.value), 120);
});

document.addEventListener('click', (ev) => {
  const ex = ev.target.closest('[data-q]');
  if (ex) { input.value = ex.dataset.q; setQuery(ex.dataset.q); input.focus(); return; }
  const day = ev.target.closest('#days [data-date]');
  if (day) { state.date = day.dataset.date; renderAll(); return; }
  const save = ev.target.closest('[data-save]');
  if (save) {
    const existing = savedFound(save.dataset.save);
    if (existing) state.mine = state.mine.filter((m) => m !== existing);
    else {
      const g = state.cards.find((c) => c.id === save.dataset.save);
      if (g) state.mine.push({ uid: uid(), kind: 'found', id: g.id, q: state.query.trim(), title: `${cardTitle(g)}${g.matched ? ', ' + g.matched : ''}` });
    }
    saveMine();
    renderResults();
    return;
  }
  const rm = ev.target.closest('[data-remove]');
  if (rm) {
    state.mine = state.mine.filter((m) => m.uid !== rm.dataset.remove);
    saveMine();
    renderResults();
    return;
  }
  if (ev.target.closest('#refresh, #retry')) load(true);
});

document.addEventListener('toggle', (ev) => {
  if (ev.target.classList?.contains('adder')) state.addOpen = ev.target.open;
}, true);

document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'add-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const title = String(f.get('title') || '').trim();
  const qid = String(f.get('qid') || '');
  if (!title || !state.data.subqueues.includes(qid)) return;
  state.mine.push({ uid: uid(), kind: 'manual', title, loc: String(f.get('loc') || '').trim(), qid });
  saveMine();
  state.addOpen = false;
  renderResults();
});

try { input.value = localStorage.getItem('gpv.q') || ''; } catch { /* ignore */ }
state.query = input.value;
tickClock();
load();
setInterval(() => load(), REFRESH_MS);
setInterval(tick, 30 * 1000);
