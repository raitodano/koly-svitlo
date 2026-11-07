'use strict';

/* Коли світло? — пошук черги ГПВ за адресою.
   Дані: /api/data (локальний server.py / KolySvitlo.exe) або data.json (GitHub Pages,
   збирає build_static.py). Як усе влаштовано — див. КАК_ЭТО_РАБОТАЕТ.md. */

const DATA_URL = window.GPV_DATA_URL || '/api/data';
const STATIC_MODE = Boolean(window.GPV_DATA_URL);
const SOURCE_URL = 'https://info.dpem.mk.ua/off_graf.html';
/* Сайт ДПЕМ не дозволяє сторінкам з інших доменів читати себе (немає CORS-заголовків),
   тому статична версія звіряє графік через публічний сервіс r.jina.ai — він завантажує
   ту саму сторінку ДПЕМ і віддає її з дозволом для браузера. Береться лише масив графіка. */
const LIVE_URL = `https://r.jina.ai/${SOURCE_URL}`;
const LIVE_TIMEOUT_MS = 40 * 1000;
const AUTO_VERIFY_AFTER_MIN = 40;  // копія старша — звіряємо самі під час відкриття
const STALE_AFTER_MIN = 90;
const TZ = 'Europe/Kyiv';
const SLOTS = 48;
const SUBQUEUES = ['1-І', '1-ІІ', '2-І', '2-ІІ', '3-І', '3-ІІ', '4-І', '4-ІІ', '5-І', '5-ІІ', '6-І', '6-ІІ'];
const REFRESH_MS = 5 * 60 * 1000;
const MAX_CARDS = 30;
const MINE_KEY = 'gpv.mine';
const HIST_KEY = 'gpv.hist';
const LIVE_KEY = 'gpv.live';
const HIST_MAX = 25;
const HIST_IDLE_MS = 2500;
const STATE_LABEL = {
  0: 'світло є', 1: 'перемикання (вимкнення)', 2: 'світла немає',
  3: 'перемикання (увімкнення)', 4: 'можливе відключення',
};
const SWITCH_LABEL = {
  'дист.': ['перемикання дистанційне', 'вмикають і вимикають з диспетчерського пункту'],
  'місц.': ['перемикання місцеве', 'вмикає й вимикає бригада на підстанції — можлива затримка'],
};
const EXAMPLES = ['Шев 10', 'Незалежності 20', 'Європейська 5А', 'Молодіжна 7', 'Степова', 'Костянтинівка Шевченка'];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  data: null, index: [], best: new Map(), date: null, query: '', order: {}, cards: [], lastRes: null,
  mine: loadMine(), hist: loadHist(), live: loadLive(), addOpen: false, openQ: new Set(), focusId: null,
  verifying: false, vres: null, lastAutoVerify: 0, lastCommit: null,
};

/* ===================== нормалізація тексту ===================== */

const FOLD = { 'і': 'и', 'ї': 'и', 'ы': 'и', 'й': 'и', 'є': 'е', 'э': 'е', 'ё': 'е', 'ґ': 'г', 'ь': '', 'ъ': '' };
const LAT = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'и', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', v: 'в', g: 'г', d: 'д' };

function fold(s) {
  return String(s).toLowerCase().replace(/[’'ʼ`]/g, '').replace(/[іїыйєэёґьъ]/g, (c) => FOLD[c]);
}
function words(s) { return fold(s).match(/[а-яa-z0-9]+/g) || []; }

const STOP = new Set(['вул', 'вулиця', 'ул', 'улица', 'бул', 'бульв', 'бульвар', 'бр', 'пр', 'прт', 'пркт', 'просп',
  'проспект', 'пров', 'провулок', 'пер', 'переулок', 'пл', 'площа', 'площадь', 'туп', 'тупик', 'мкр', 'мікрорайон',
  'смт', 'село', 'місто', 'город', 'буд', 'будинок', 'дом', 'кв', 'квартира', 'номер'].map(fold));

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

/* ===================== повні назви (без скорочень) ===================== */

const TYPE_FULL = {
  'вул.': 'вулиця', 'б-р': 'бульвар', 'пр-т': 'проспект', 'пров.': 'провулок', 'пл.': 'площа',
  'туп.': 'тупик', 'мкр.': 'мікрорайон',
  // «пр.» у переліках — і проспект, і провулок; якщо для вулиці ніде немає «пр-т», це провулок
  'пр.': 'провулок',
};
const NAME_FULL = Object.fromEntries([
  ['Л. Українки', 'Лесі Українки'], ['Я. Мудрого', 'Ярослава Мудрого'],
].map(([a, b]) => [words(a).join(' '), b]));

/** Найкращий варіант написання: з типом вулиці, без крапок, з великої літери. */
function nameRank(e) {
  const caps = (e.name.match(/(^|\s)[А-ЯІЇЄҐA-Z]/g) || []).length;
  return (e.kind === 'street' ? 4 : 0) + (e.type ? 2 : 0) + (e.type === 'пр.' ? -1 : 0)
    + (e.name.includes('.') ? -3 : 0) + caps * 0.3 + e.name.length / 100;
}
function bestEntry(entries) { return [...entries].sort((a, b) => nameRank(b) - nameRank(a))[0]; }

function fullName(e) {
  let name = NAME_FULL[words(e.name).join(' ')] || e.name;
  name = name.replace(/^[а-яіїєґa-z]/, (c) => c.toUpperCase());
  if (e.kind !== 'street') return name;
  const t = TYPE_FULL[e.type] ?? e.type;
  return t ? `${t} ${name}` : name;
}
const shortLoc = (loc) => String(loc || '').replace(/^(м|с|смт)\.\s*/, '');

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

/** Для кожної вулиці — найповніший варіант назви з усіх переліків. */
function buildBest(index) {
  const groups = new Map();
  for (const it of index) {
    if (!groups.has(it.key)) groups.set(it.key, []);
    groups.get(it.key).push(it.entry);
  }
  return new Map([...groups].map(([k, es]) => [k, bestEntry(es)]));
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
  if (!qw.length) return { house, words: qw, cards: [], total: 0, misses: [], noWords: true };

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

/** Найкращий варіант написання назви серед збігів картки (з урахуванням інших переліків). */
function displayEntry(hits) {
  return state.best.get(hits[0].key) || bestEntry(hits.map((h) => h.entry));
}
function cardTitle(g) { return fullName(displayEntry(g.hits)); }
function sortHouses(list) {
  return [...list].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b, 'uk'));
}
/** Номер для заголовка: як у переліку («54-Б»), але для діапазону «37-39» — той, що шукали. */
function shownHouse(g, house) {
  if (!house) return '';
  return g.level === 'exact' && normHouse(g.matched) === house ? g.matched : house.toUpperCase();
}
const qidsOf = (g) => [...new Set(g.hits.map((h) => h.qid))].sort((a, b) => state.order[a] - state.order[b]);

/* ===================== збереження в браузері ===================== */

function readJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватний режим */ }
}
const uid = () => Math.random().toString(36).slice(2, 10);

function loadMine() {
  const v = readJson(MINE_KEY, []);
  return Array.isArray(v) ? v.filter((m) => m && (m.kind === 'found' || m.kind === 'manual')) : [];
}
const saveMine = () => writeJson(MINE_KEY, state.mine);
const savedFound = (id) => state.mine.find((m) => m.kind === 'found' && m.id === id);

function loadHist() {
  const v = readJson(HIST_KEY, []);
  return Array.isArray(v) ? v.filter((h) => h && h.uid && h.id && h.title && h.q).slice(0, HIST_MAX) : [];
}
const saveHist = () => writeJson(HIST_KEY, state.hist);

/** Графіки, звірені напряму з сайтом ДПЕМ (щоб після перезавантаження не повертатись до старішої копії). */
function loadLive() {
  const v = readJson(LIVE_KEY, null);
  if (!v || !Array.isArray(v.schedules) || !v.checked_at) return null;
  return Date.now() - Date.parse(v.checked_at) < 36 * 3600 * 1000 ? v : null;
}

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
/** Момент часу (ISO) → «01:24» сьогодні або «06.11 о 21:19». */
function whenKyiv(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return date === kyivNow().date ? `${p.hour}:${p.minute}` : `${p.day}.${p.month} о ${p.hour}:${p.minute}`;
}
/** saved_at з сайту ДПЕМ («2026-11-06 19:02:03», київський час) → «06.11 о 19:02». */
const savedKyiv = (s) => (s && s.length >= 16 ? `${ddmm(s.slice(0, 10))} о ${s.slice(11, 16)}` : '');
function dayWord(d) {
  const now = kyivNow().date;
  if (d === now) return 'сьогодні';
  if (d === addDays(now, 1)) return 'завтра';
  if (d === addDays(now, -1)) return 'вчора';
  return new Intl.DateTimeFormat('uk-UA', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'));
}

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
function winsText(vals) {
  if (!vals || vals.every((v) => v === null)) return 'немає даних';
  const ws = windowsOf(vals);
  const off = ws.filter((w) => w.type === 'off').map((w) => `${fmt(w.from)}–${fmt(w.to)}`);
  const maybe = ws.filter((w) => w.type === 'maybe').map((w) => `${fmt(w.from)}–${fmt(w.to)}`);
  return [off.length ? off.join(', ') : 'без відключень', maybe.length ? `можливо ${maybe.join(', ')}` : ''].filter(Boolean).join(' · ');
}

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

/* ===================== картки адрес ===================== */

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

const feedersOf = (rows) => [...new Set(rows.map((r) => r.feeder))];
const joinUk = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} і ${list[list.length - 1]}` : list.join(''));
function rowsLabel(rows) {
  const subs = [...new Set(rows.map((r) => r.substation))].join(', ');
  const fs = feedersOf(rows);
  return `${subs} · ${fs.length > 1 ? 'фідери' : 'фідер'} ${fs.join(', ')}${rows.some((r) => r.partial) ? ' · частково' : ''}`;
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
  let title = esc(fullName(e));
  const flags = [];
  if (house && g.level === 'exact') title += `, ${esc(shownHouse(g, house))}`;
  if (g.level === 'close') flags.push(`<span class="flag warn">Будинку «${esc(house.toUpperCase())}» у переліку немає, знайдено схожий номер: ${esc(g.matched)}</span>`);
  if (g.level === 'street') flags.push('<span class="flag">Номери будинків не вказані — у переліку вулиця загалом (може бути частково)</span>');
  if (g.level === 'object') flags.push('<span class="flag">Згадка в переліку без номера будинку</span>');
  const notes = [...new Set(g.hits.map((h) => h.entry.note).filter(Boolean))];
  if (notes.length) flags.push(`<span class="flag">У переліку: «${esc(notes.join(', '))}»</span>`);

  const bySq = new Map();
  for (const h of g.hits) {
    if (!bySq.has(h.qid)) bySq.set(h.qid, []);
    bySq.get(h.qid).push(h);
  }
  const sqs = qidsOf(g);
  if (sqs.length > 1) {
    const n = sqs.length;
    const lines = joinUk(sqs.map((q) => `${q} (фідер ${feedersOf(bySq.get(q).map((h) => h.row)).join(', ')})`));
    const all = n === 2 ? 'обидва графіки' : 'усі ці графіки';
    if (g.level === 'exact') {
      flags.push(`<span class="flag warn">Будинок живиться від ${n === 2 ? 'двох ліній' : `${n} ліній`}: ${esc(lines)}. Які під'їзди від якої лінії — ДПЕМ не публікує, тож зважайте на ${all}.</span>`);
    } else if (!house && g.hits.some((h) => h.entry.houses.length)) {
      flags.push(`<span class="flag">Будинки цієї вулиці — у ${n} підчергах: ${esc(lines)}. Додайте номер будинку, щоб побачити саме свій графік.</span>`);
    } else {
      flags.push(`<span class="flag">Адреса є в ${n} підчергах: ${esc(lines)} — зважайте на ${all}.</span>`);
    }
  }

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

  return `<article class="card"${opts.savedUid ? '' : ` data-gid="${esc(g.id)}"`}>
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
    return `<div class="miss"><b>${esc(fullName(e))}</b> (${esc(e.loc)}):
      будинку <b>${esc(house.toUpperCase())}</b> у переліках ГПВ немає. Є: ${esc(sortHouses(m.houses).join(', '))}.</div>`;
  }).join('');
}

function renderResults() {
  const box = $('#results');
  if (!state.data) return;
  const q = state.query.trim();
  state.cards = [];
  state.lastRes = null;

  if (!q) {
    const mine = state.mine.length
      ? `<div class="sec-title">Мої адреси</div>${renderMineCards()}`
      : '';
    box.innerHTML = `${mine}
      <div class="hint"><p>${state.mine.length ? 'Шукайте іншу адресу:' : 'Почніть вводити вулицю й номер будинку — можна скорочено, наприклад «Шев 10». Знайдену адресу можна зберегти ☆, і вона показуватиметься тут одразу.'}</p>
      <div class="examples">${EXAMPLES.map((x) => `<button type="button" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>
      ${adderHtml('', state.addOpen)}`;
    renderHistory();
    return;
  }

  const res = search(q);
  if (state.focusId) {
    const i = res.cards.findIndex((c) => c.id === state.focusId);
    if (i > 0) res.cards.unshift(...res.cards.splice(i, 1));
  }
  state.cards = res.cards;
  state.lastRes = res;
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
  renderHistory();
}

/* ===================== історія пошуку (ліворуч) ===================== */

/** Запит, який знову знайде саме цю картку, — повною назвою, а не «шев 10». */
function canonicalQuery(g, title, typed) {
  const e = displayEntry(g.hits);
  for (const q of [title, `${shortLoc(e.loc)} ${title}`]) {
    if (search(q).cards.some((c) => c.id === g.id)) return q;
  }
  return typed;
}

/**
 * Записати адресу в історію. mode: 'enter' / 'click' — завжди; 'idle' / 'blur' — лише коли
 * результат однозначний (знайдено конкретний будинок або єдиний збіг), щоб не засмічувати історію.
 */
function commitHistory(mode, gid) {
  const res = state.lastRes;
  const typed = state.query.trim();
  if (!res || !typed || !res.cards.length) return;
  const g = (gid && res.cards.find((c) => c.id === gid)) || res.cards[0];
  const sure = res.cards.length === 1 || (res.house && g.level === 'exact');
  if ((mode === 'idle' || mode === 'blur') && !sure) return;

  const e = displayEntry(g.hits);
  const h = shownHouse(g, res.house);
  const title = `${fullName(e)}${h ? `, ${h}` : ''}`;
  const item = {
    uid: uid(), id: g.id, title, loc: e.loc, qids: qidsOf(g), q: canonicalQuery(g, title, typed),
    note: g.level === 'close' ? `схожий номер ${g.matched}` : g.level === 'street' ? 'вулиця загалом' : '', t: Date.now(),
  };
  // поки людина друкує «Шев 1» → «Шев 10», замінюємо щойно доданий автоматично запис
  const lc = state.lastCommit;
  if (lc && lc.auto && Date.now() - lc.t < 20000 && lc.id !== item.id
      && (fold(typed).startsWith(fold(lc.typed)) || fold(lc.typed).startsWith(fold(typed)))) {
    state.hist = state.hist.filter((x) => x.id !== lc.id);
  }
  state.hist = [item, ...state.hist.filter((x) => x.id !== item.id && x.title !== item.title)].slice(0, HIST_MAX);
  state.lastCommit = { id: item.id, typed, t: Date.now(), auto: mode === 'idle' || mode === 'blur' };
  saveHist();
  renderHistory();
}

function histStatus(qids) {
  const now = kyivNow();
  if (!schedule(now.date)) return null;
  const sts = qids.map((q) => statusFor(rowVals(now.date, q), now.minutes));
  const off = sts.find((s) => s.cls === 'off');
  if (off) return { cls: 'off', text: 'зараз світла немає' };
  if (sts.some((s) => s.cls === 'maybe')) return { cls: 'maybe', text: 'зараз можливе відключення' };
  if (sts.every((s) => s.cls === 'unknown')) return null;
  return { cls: 'on', text: 'зараз світло є' };
}

function renderHistory() {
  const box = $('#hist');
  $('#hist-clear').hidden = !state.hist.length;
  if (!state.hist.length) {
    box.innerHTML = '<li class="hist-empty">Тут з’являться адреси, які ви шукали, — повними назвами, наприклад «бульвар Шевченка, 10».</li>';
    return;
  }
  const cur = state.query.trim() && state.cards[0] ? state.cards[0].id : null;
  box.innerHTML = state.hist.map((h) => {
    const st = state.data ? histStatus(h.qids || []) : null;
    const sub = [shortLoc(h.loc), (h.qids || []).join(' · '), h.note].filter(Boolean).join(' · ');
    return `<li${h.id === cur ? ' class="cur"' : ''}>
      <button type="button" class="hist-go" data-hist="${esc(h.uid)}">
        <i class="dot ${st ? st.cls : 'none'}" title="${esc(st ? st.text : '')}"></i>
        <b>${esc(h.title)}</b><span>${esc(sub)}</span>
      </button>
      <button type="button" class="hist-x" data-hist-del="${esc(h.uid)}" aria-label="Прибрати «${esc(h.title)}» з історії">×</button>
    </li>`;
  }).join('');
}

function setDrawer(open) {
  document.body.classList.toggle('side-open', open);
  $('#side-backdrop').hidden = !open;
  $('#hist-toggle').setAttribute('aria-expanded', String(open));
}

/* ===================== дні, огляд усіх черг ===================== */

function renderDays() {
  const now = kyivNow();
  const dates = state.data.schedules.map((s) => s.date);
  const shown = dates.filter((d) => d >= addDays(now.date, -1)).slice(0, 4);
  if (!shown.length) shown.push(...dates.slice(0, 2));
  if (!shown.includes(state.date)) shown.push(state.date);
  shown.sort();
  $('#days').innerHTML = shown.map((d) => {
    const w = dayWord(d);
    return `<button type="button" role="tab" data-date="${d}" aria-selected="${d === state.date}">${w[0].toUpperCase() + w.slice(1)}<small>${ddmm(d)}</small></button>`;
  }).join('');
}

/** Плашка підчерги: які адреси вимикаються і від яких фідерів вони живляться. */
function queuePanelHtml(qid) {
  const q = state.data.queues.find((x) => x.id === qid);
  if (!q || !q.rows.length) return '<p class="qp-empty">Переліку адрес для цієї підчерги на сайті ДПЕМ немає.</p>';
  const fs = feedersOf(q.rows);
  const intro = `<p class="qp-intro">Підчерга <b>${esc(qid)}</b> — ${fs.length} ${fs.length === 1 ? 'лінія (фідер)' : fs.length < 5 ? 'лінії (фідери)' : 'ліній (фідерів)'}.
    За графіком вимикається все, що нижче. Натисніть на вулицю — покажу її картку.</p>`;
  const blocks = q.rows.map((r) => {
    const sw = SWITCH_LABEL[r.switch];
    const byLoc = new Map();
    for (const e of r.entries) {
      if (!byLoc.has(e.loc)) byLoc.set(e.loc, { streets: [], other: [] });
      byLoc.get(e.loc)[e.kind === 'street' ? 'streets' : 'other'].push(e);
    }
    const locs = [...byLoc].map(([loc, { streets, other }]) => {
      const streetBtn = (e) => {
        const key = `${e.loc}|${streetKey(e.name)}`;
        const best = state.best.get(key) || e;
        // у місті — просто назва (потрібна картка стане першою), в інших населених пунктах — з його назвою
        const sq = `${loc.includes('Південноукраїнськ') ? '' : shortLoc(loc) + ' '}${fullName(best)}`;
        return `<button type="button" class="qp-street" data-q="${esc(sq)}" data-focus="${esc(`${key}||`)}">${esc(fullName(best))}</button>`;
      };
      const note = (e) => (e.note ? ` <span class="muted">(${esc(e.note)})</span>` : '');
      const lis = streets.filter((e) => e.houses.length)
        .map((e) => `<li>${streetBtn(e)} <span class="qp-h">${sortHouses(e.houses).map(esc).join(', ')}</span>${note(e)}</li>`);
      const whole = streets.filter((e) => !e.houses.length);
      if (whole.length) {
        lis.push(`<li><span class="muted">Без номерів будинків (вулиця загалом):</span> ${whole.map((e) => streetBtn(e) + note(e)).join(', ')}</li>`);
      }
      if (other.length) {
        const objs = other.map((e) => esc(`${e.name}${e.houses.length ? ` ${e.houses.join(', ')}` : ''}${e.note ? ` ${e.note}` : ''}`));
        lis.push(`<li class="qp-obj"><span class="muted">Об’єкти:</span> ${objs.join(', ')}</li>`);
      }
      return `<div class="qp-loc">${esc(loc)}</div><ul class="qp-list">${lis.join('')}</ul>`;
    }).join('');
    return `<section class="fd">
      <div class="fd-head">
        <span class="fd-no">Фідер ${esc(r.feeder)}</span>
        <span class="fd-meta">${esc(r.substation)}${sw ? ` · <span title="${esc(sw[1])}">${esc(sw[0])}</span>` : r.switch ? ` · ${esc(r.switch)}` : ''}</span>
        ${r.partial ? '<span class="fd-part" title="На сайті ДПЕМ перелік позначено «частково»: частина будинку чи вулиці може живитися від іншої лінії">частково</span>' : ''}
      </div>
      ${locs || '<p class="qp-empty">Адрес у переліку не вказано.</p>'}
      <details class="raw-box"><summary>Як записано на сайті ДПЕМ</summary><div class="raw">${esc(r.text)}</div></details>
    </section>`;
  }).join('');
  return intro + blocks;
}

function renderOverview() {
  const sch = schedule(state.date);
  $('#overview-title').textContent = `Усі черги · ${ddmm(state.date)}`;
  if (!sch) { $('#overview').innerHTML = '<div class="hm"><div class="empty">Графік на цю дату не опубліковано.</div></div>'; return; }
  const hit = new Set(state.cards.flatMap((g) => g.hits.map((h) => h.qid)));
  const now = kyivNow();
  const today = state.date === now.date;
  const rows = state.data.subqueues.map((qid) => {
    const vals = sch.rows[qid];
    const mins = offMinutes(vals);
    const open = state.openQ.has(qid);
    const nf = feedersOf(state.data.queues.find((x) => x.id === qid)?.rows || []).length;
    const cells = vals.map((v, i) => `<i class="c v${v ?? 'x'}" title="${esc(qid)} · ${fmt(i)}–${fmt(i + 1)} · ${esc(STATE_LABEL[v] ?? 'немає даних')}"></i>`).join('');
    return `<div class="hm-item${open ? ' open' : ''}">
      <div class="hm-row${mins ? '' : ' dim'}${hit.has(qid) ? ' hit' : ''}" role="button" tabindex="0" aria-expanded="${open}" data-sq="${esc(qid)}">
        <span class="hm-lab">${esc(qid)}</span><div class="hm-cells">${cells}</div><span class="hm-sum">${mins ? esc(durShort(mins)) : '—'}</span>
        <div class="hm-times"><span>${esc(winsText(vals))}</span><span class="hm-more">${open ? 'сховати' : `адреси · ${nf} ${nf === 1 ? 'фідер' : nf < 5 ? 'фідери' : 'фідерів'}`}</span></div>
      </div>
      ${open ? `<div class="hm-panel">${queuePanelHtml(qid)}</div>` : ''}
    </div>`;
  }).join('');
  $('#overview').innerHTML = `<div class="hm${today ? ' today' : ''}" style="--now:${(now.minutes / 1440).toFixed(4)}">
    <div class="hm-hours"><span></span><div><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div><span class="sumh" title="без світла за добу">вимк.</span></div>
    ${rows}</div>`;
}

/* ===================== звірка з сайтом ДПЕМ ===================== */

/** Коли востаннє дані точно відповідали сайту ДПЕМ. */
function freshAt() {
  const a = state.data?.fetched_at ? Date.parse(state.data.fetched_at) : 0;
  const b = STATIC_MODE && state.live ? Date.parse(state.live.checked_at) : 0;
  return Math.max(a || 0, b || 0);
}

function renderSync() {
  renderSyncText();
  renderSyncResult();
}

/** Рядок стану біля кнопки: коли ДПЕМ опублікував графік і коли ми його звіряли. */
function renderSyncText() {
  const btn = $('#verify');
  btn.disabled = state.verifying;
  btn.classList.toggle('busy', state.verifying);
  btn.querySelector('span').textContent = state.verifying ? 'Звіряю…' : 'Звірити графіки';
  if (!state.data) { $('#sync-text').innerHTML = ''; return; }

  const sch = schedule(state.date);
  const at = freshAt();
  const ageMin = at ? (Date.now() - at) / 60000 : Infinity;
  const viaLive = STATIC_MODE && state.live && Date.parse(state.live.checked_at) >= Date.parse(state.data.fetched_at || 0);
  const line1 = sch?.saved_at
    ? `Графік на ${ddmm(sch.date)} опубліковано на сайті ДПЕМ ${savedKyiv(sch.saved_at)}`
    : `Графіка на ${ddmm(state.date)} немає`;
  let line2;
  if (!at) line2 = 'ще не перевірено';
  else if (!STATIC_MODE) line2 = `програма перевірила сайт ДПЕМ о ${whenKyiv(new Date(at).toISOString())}`;
  else if (viaLive) line2 = `звірено з сайтом ДПЕМ о ${whenKyiv(new Date(at).toISOString())}`;
  else line2 = `копія на цьому сайті від ${whenKyiv(new Date(at).toISOString())}`;
  const warn = ageMin > STALE_AFTER_MIN && !state.verifying;
  if (warn) line2 += ' — могло змінитися, звірте';
  $('#sync').classList.toggle('warn', warn);
  $('#sync-text').innerHTML = `<b>${esc(line1)}</b><span>${esc(line2)}</span>`;
}

/** Результат звірки: збігається / що змінилося / чому не вдалося. */
function renderSyncResult() {
  const v = state.vres;
  const at = freshAt();
  const box = $('#sync-res');
  if (!v) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.className = `sync-res ${v.status}`;
  const close = '<button type="button" class="sync-x" data-vclose aria-label="Закрити">×</button>';
  if (v.status === 'busy') {
    box.innerHTML = `<b>Завантажую графік із сайту ДПЕМ…</b><span>${STATIC_MODE ? 'Сторінка ДПЕМ велика (≈1,5 МБ), зазвичай 5–10 секунд.' : 'Програма звертається до сайту ДПЕМ.'}</span>`;
    return;
  }
  const latest = state.data.schedules.filter((s) => s.date >= kyivNow().date).map((s) => s.saved_at).sort().pop();
  const tail = v.at ? `Звірено о ${whenKyiv(v.at)}${latest ? ` · останні зміни графіка на ДПЕМ — ${savedKyiv(latest)}` : ''}.` : '';
  if (v.status === 'same') {
    box.innerHTML = `${close}<b>✓ Графіки збігаються з сайтом ДПЕМ</b><span>${esc(tail)}</span>`;
  } else if (v.status === 'changed') {
    box.innerHTML = `${close}<b>Графік на сайті ДПЕМ змінився — уже показано новий</b>${changesHtml(v.changes)}<span>${esc(tail)}</span>`
      + (v.reason ? `<span>Напряму звірити не вдалося (${esc(v.reason)}), зміни взято з копії сайту.</span>` : '');
  } else {
    box.innerHTML = `${close}<b>Не вдалося звірити з сайтом ДПЕМ</b>
      <span>${esc(v.reason)}. Показано ${STATIC_MODE ? 'копію' : 'збережену копію'} від ${esc(at ? whenKyiv(new Date(at).toISOString()) : '—')}.
      <a href="${SOURCE_URL}" target="_blank" rel="noopener">Відкрити графік на сайті ДПЕМ</a></span>
      <button type="button" class="sync-again" data-verify>Спробувати ще</button>`;
  }
}

function changesHtml(changes) {
  const mineQ = new Set([...state.cards.flatMap(qidsOf), ...state.mine.map((m) => m.qid).filter(Boolean), ...state.hist.slice(0, 5).flatMap((h) => h.qids || [])]);
  return `<ul class="chg">${changes.map((c) => {
    const day = `${dayWord(c.date)} ${ddmm(c.date)}`;
    if (c.added) return `<li><b>${esc(day)}</b>: опубліковано графік на цей день</li>`;
    const first = c.qids.filter((q) => mineQ.has(q));
    const shown = (first.length ? first : c.qids).slice(0, 4);
    const rest = c.qids.filter((q) => !shown.includes(q));
    const det = shown.map((q) => `<div><span class="tag-s">${esc(q)}</span> було ${esc(winsText(c.before[q]))} → <b>${esc(winsText(c.after[q]))}</b></div>`).join('');
    return `<li><b>${esc(day)}</b>: змінено ${c.qids.length === 12 ? 'усі підчерги' : `${c.qids.length === 1 ? 'підчергу' : 'підчерги'} ${esc(c.qids.join(', '))}`}${det}${rest.length ? `<div class="muted">інші: ${esc(rest.join(', '))}</div>` : ''}</li>`;
  }).join('')}</ul>`;
}

/** Масив records зі сторінки ДПЕМ → графіки (та сама логіка, що й у dpem.py). */
function parseRecords(page) {
  const m = page.match(/\brecords\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])\s*;/);
  if (!m) throw new Error('на сторінці ДПЕМ не знайдено графіка');
  let raw;
  try { raw = JSON.parse(m[1]); } catch { throw new Error('не вдалося прочитати графік на сторінці ДПЕМ'); }
  const sq = state.data?.subqueues || SUBQUEUES;
  const need = SLOTS * sq.length;
  const best = new Map();
  for (const rec of Array.isArray(raw) ? raw : []) {
    const date = String(rec?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const vals = (Array.isArray(rec.data) ? rec.data : []).slice(0, need).map((v) => {
      const s = String(v ?? '').trim();
      const n = s === '' ? NaN : Number(s);
      return Number.isInteger(n) ? n : null;
    });
    while (vals.length < need) vals.push(null);
    const saved = String(rec.saved_at ?? '');
    const prev = best.get(date);
    if (prev && prev.saved_at >= saved) continue;
    best.set(date, { date, saved_at: saved, rows: Object.fromEntries(sq.map((q, i) => [q, vals.slice(i * SLOTS, (i + 1) * SLOTS)])) });
  }
  if (!best.size) throw new Error('на сторінці ДПЕМ немає жодного графіка');
  return [...best.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function fetchLive() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIVE_TIMEOUT_MS);
  try {
    const r = await fetch(LIVE_URL, {
      headers: { 'X-Return-Format': 'html', 'X-No-Cache': 'true' }, cache: 'no-store', signal: ctrl.signal,
    });
    if (r.status === 429) throw new Error('забагато перевірок поспіль — спробуйте за хвилину');
    if (!r.ok) throw new Error(`сервіс, через який читається сайт ДПЕМ, відповів помилкою ${r.status}`);
    return parseRecords(await r.text());
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`сайт ДПЕМ не відповів за ${LIVE_TIMEOUT_MS / 1000} секунд`);
    if (err instanceof TypeError) throw new Error('немає з’єднання з сайтом ДПЕМ');
    throw err;
  } finally { clearTimeout(timer); }
}

/** Для кожної дати — найсвіжіша версія графіка (за часом збереження на сайті ДПЕМ). */
function mergeSchedules(base, extra) {
  const by = new Map(base.map((s) => [s.date, s]));
  for (const s of extra || []) {
    const b = by.get(s.date);
    if (!b || (s.saved_at || '') > (b.saved_at || '')) by.set(s.date, s);
  }
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
}

function diffSchedules(before, after) {
  const today = kyivNow().date;
  const out = [];
  for (const s of after) {
    if (s.date < today) continue;
    const o = before.find((x) => x.date === s.date);
    if (!o) { if (before.length) out.push({ date: s.date, added: true }); continue; }
    const qids = Object.keys(s.rows).filter((q) => JSON.stringify(s.rows[q]) !== JSON.stringify(o.rows[q]));
    if (qids.length) out.push({ date: s.date, qids, before: o.rows, after: s.rows });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * «Звірити графіки»: exe/сервер — програма сама перечитує сайт ДПЕМ; статичний сайт — свіжа
 * копія data.json + сторінка ДПЕМ напряму (через r.jina.ai). auto — тиха перевірка застарілої копії.
 */
async function verify(auto = false) {
  if (state.verifying || (auto && !state.data)) return;
  state.verifying = true;
  if (!auto) state.vres = { status: 'busy' };
  renderSync();
  const before = state.data ? state.data.schedules : [];
  let ok = false, at = null, reason = '';
  try {
    if (STATIC_MODE) {
      const [copy, live] = await Promise.allSettled([fetchJson(`${DATA_URL}?t=${Date.now()}`), fetchLive()]);
      if (live.status === 'fulfilled') {
        const from = addDays(kyivNow().date, -1);
        state.live = { checked_at: new Date().toISOString(), schedules: live.value.filter((s) => s.date >= from) };
        writeJson(LIVE_KEY, state.live);
        ok = true; at = state.live.checked_at;
      } else reason = live.reason?.message || 'невідома помилка';
      const base = copy.status === 'fulfilled' ? copy.value : state.data && { ...state.data };
      if (base) applyData(base);
    } else {
      const d = await fetchJson(`${DATA_URL}?refresh=1`);
      applyData(d);
      if (d.stale && d.error) reason = `програма не змогла завантажити сайт ДПЕМ (${d.error})`;
      else { ok = true; at = d.fetched_at; }
    }
  } catch (err) {
    reason = err.message;
  }
  const changes = state.data ? diffSchedules(before, state.data.schedules) : [];
  state.verifying = false;
  if (auto) {
    state.lastAutoVerify = Date.now();
    if (changes.length) state.vres = { status: 'changed', changes, at, reason: ok ? '' : reason };
  } else if (changes.length) state.vres = { status: 'changed', changes, at, reason: ok ? '' : reason };
  else state.vres = ok ? { status: 'same', at } : { status: 'fail', reason };
  renderSync();
}

function maybeAutoVerify() {
  if (!STATIC_MODE || !state.data || state.verifying || document.visibilityState === 'hidden') return;
  const ageMin = (Date.now() - freshAt()) / 60000;
  if (ageMin > AUTO_VERIFY_AFTER_MIN && Date.now() - state.lastAutoVerify > 15 * 60 * 1000) verify(true);
}

/* ===================== Персоналізація: теми ===================== */

const THEME_KEY = 'gpv.theme';
const THEMES = [
  ['auto', 'Стандартна', 'як у системі: світла чи темна'],
  ['light', 'Світла', 'завжди світла'],
  ['dark', 'Темна', 'завжди темна'],
  ['oled', 'Нічна', 'чорне тло, береже батарею'],
  ['contrast', 'Контрастна', 'для сонця й слабкого зору'],
  ['sepia', 'Папір', 'тепла, м’яка для очей'],
  ['sea', 'Морська ніч', 'глибокий синій'],
  ['mint', 'М’ята', 'світла, прохолодна'],
];
const currentTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } };

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_KEY, t); } catch { /* приватний режим */ }
  const mastColor = getComputedStyle(document.documentElement).getPropertyValue('--mast').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mastColor || '#16171b');
}

function themePreview(id) {
  const body = `<div class="tp-mast"><i></i><b></b></div><div class="tp-body"><div class="tp-card">
    <div class="tp-bar"><span></span><span></span><span class="s"></span><span class="d"></span><span class="d"></span><span class="d"></span><span class="s"></span><span></span><span class="m"></span><span class="m"></span><span></span><span></span></div>
    <div class="tp-line"></div></div></div>`;
  if (id === 'auto') return `<span class="theme-prev split"><div data-theme="light">${body}</div><div data-theme="dark">${body}</div></span>`;
  return `<span class="theme-prev" data-theme="${id}">${body}</span>`;
}

function renderThemes() {
  const cur = currentTheme();
  $('#themes').innerHTML = THEMES.map(([id, name, hint]) => `<label class="theme-card">
    <input type="radio" name="theme" value="${id}"${id === cur ? ' checked' : ''}>${themePreview(id)}
    <span class="theme-name">${esc(name)}<small>${esc(hint)}</small></span></label>`).join('');
}

/* ===================== вкладки: графік / Персоналізація ===================== */

const isPersonal = () => location.hash === '#personal';
function renderView() {
  const p = isPersonal();
  document.body.classList.toggle('view-personal', p);
  $('#personal').hidden = !p;
  $('#pers-toggle').setAttribute('aria-current', p ? 'page' : 'false');
  if (p) { renderThemes(); renderDistPick(); renderWidgetBox(); window.scrollTo({ top: 0 }); }
}
function leavePersonal() {
  if (!isPersonal()) return;
  history.replaceState(null, '', location.pathname + location.search);
  renderView();
}

/* ===================== мікрорайони ===================== */

const DIST_KEY = 'gpv.districts';
state.distSel = new Set(readJson(DIST_KEY, []));
state.osmDistricts = null;   // з districts.json (межі з OpenStreetMap)
state.dist = new Map();      // id → { name, kind, qids: Map(qid → {houses: Map(вулиця → Set), whole: Set, objects: Set}) }
state.distUnknown = 0;

const TYPE_WORDS = new Set(['вулиця', 'вул', 'бульвар', 'бул', 'бр', 'проспект', 'просп', 'прт', 'провулок', 'пров',
  'площа', 'пл', 'тупик', 'туп', 'мікрорайон', 'мкр', 'майдан'].map(fold));
const osmKey = (name) => words(name).filter((w) => !TYPE_WORDS.has(w)).map((w) => w.slice(0, 5)).join(' ');
const MAIN_CITY = 'Південноукраїнськ';

async function loadDistricts() {
  try {
    const r = await fetch('districts.json', { cache: 'no-cache' });
    state.osmDistricts = (await r.json()).districts || [];
  } catch { state.osmDistricts = []; }
  buildDistricts();
  renderDistricts();
  if (isPersonal()) renderDistPick();
}

/** Розкладає адреси з переліків ДПЕМ по мікрорайонах (і населених пунктах громади). */
function buildDistricts() {
  state.dist = new Map();
  state.distUnknown = 0;
  if (!state.data || !state.osmDistricts) return;
  const exact = new Map(), byStreet = new Map(), streets = new Map();
  for (const d of state.osmDistricts) {
    state.dist.set(d.id, { id: d.id, name: d.name, kind: 'city', qids: new Map() });
    for (const [st, hs] of Object.entries(d.houses)) {
      const k = osmKey(st);
      for (const h of hs) {
        const nh = normHouse(h);
        if (!exact.has(`${k}|${nh}`)) exact.set(`${k}|${nh}`, d.id);
        const n = parseInt(nh, 10);
        if (n) { if (!byStreet.has(k)) byStreet.set(k, []); byStreet.get(k).push({ n, d: d.id }); }
      }
    }
    for (const st of d.streets) {
      const k = osmKey(st);
      if (!streets.has(k)) streets.set(k, new Set());
      streets.get(k).add(d.id);
    }
  }
  // будинок → мікрорайон: точний номер, номер без літери/дробу, найближчий сусід на тій самій вулиці
  const houseDistrict = (k, raw) => {
    const nh = normHouse(raw);
    if (exact.has(`${k}|${nh}`)) return exact.get(`${k}|${nh}`);
    const r = nh.match(/^(\d+)-(\d+)$/);
    if (r) for (let n = +r[1]; n <= +r[2]; n++) if (exact.has(`${k}|${n}`)) return exact.get(`${k}|${n}`);
    const base = houseBase(nh);
    if (base && exact.has(`${k}|${base}`)) return exact.get(`${k}|${base}`);
    const n = parseInt(base, 10);
    const near = (byStreet.get(k) || []).map((x) => ({ ...x, dd: Math.abs(x.n - n) + (x.n % 2 === n % 2 ? 0 : 2.5) }))
      .filter((x) => x.dd <= 6).sort((a, b) => a.dd - b.dd)[0];
    return near ? near.d : null;
  };
  const slot = (id, name, kind, qid) => {
    if (!state.dist.has(id)) state.dist.set(id, { id, name, kind, qids: new Map() });
    const q = state.dist.get(id).qids;
    if (!q.has(qid)) q.set(qid, { houses: new Map(), whole: new Set(), objects: new Set() });
    return q.get(qid);
  };
  for (const q of state.data.queues) {
    for (const row of q.rows) {
      for (const e of row.entries) {
        const best = state.best.get(`${e.loc}|${streetKey(e.name)}`) || e;
        if (!e.loc.includes(MAIN_CITY)) { // села й селища громади — окремими «районами»
          const s = slot(`loc:${e.loc}`, shortLoc(e.loc), 'loc', q.id);
          if (e.kind === 'street') {
            if (e.houses.length) e.houses.forEach((h) => (s.houses.get(fullName(best)) || s.houses.set(fullName(best), new Set()).get(fullName(best))).add(h));
            else s.whole.add(fullName(best));
          } else s.objects.add(e.name);
          continue;
        }
        if (e.kind !== 'street') continue;
        const k = streetKey(e.name);
        if (!e.houses.length) {
          for (const id of streets.get(k) || []) slot(id, '', 'city', q.id).whole.add(fullName(best));
          continue;
        }
        for (const h of e.houses) {
          const id = houseDistrict(k, h);
          if (!id) { state.distUnknown++; continue; }
          const s = slot(id, '', 'city', q.id);
          const t = fullName(best);
          if (!s.houses.has(t)) s.houses.set(t, new Set());
          s.houses.get(t).add(h);
        }
      }
    }
  }
}

const distHouseCount = (d) => [...d.qids.values()].reduce((s, x) => s + [...x.houses.values()].reduce((a, b) => a + b.size, 0), 0);
const distList = (kind) => [...state.dist.values()].filter((d) => d.kind === kind && d.qids.size)
  .sort((a, b) => a.name.localeCompare(b.name, 'uk', { numeric: true }));

function renderDistPick() {
  const box = $('#dist-pick');
  if (!box) return;
  if (!state.osmDistricts || !state.data) { box.innerHTML = '<p class="pers-note">Завантажую…</p>'; return; }
  const chip = (d) => {
    const n = distHouseCount(d);
    const sub = `${d.qids.size} ${d.qids.size === 1 ? 'підчерга' : d.qids.size < 5 ? 'підчерги' : 'підчерг'}${n ? ` · ${n} буд.` : ''}`;
    return `<label class="chip"><input type="checkbox" data-dist="${esc(d.id)}"${state.distSel.has(d.id) ? ' checked' : ''}><span>${esc(d.name)}<small>${esc(sub)}</small></span></label>`;
  };
  const city = distList('city'), locs = distList('loc');
  box.innerHTML = `<div class="chips">${city.map(chip).join('')}</div>
    ${locs.length ? `<div class="chips-sub">Населені пункти громади</div><div class="chips">${locs.map(chip).join('')}</div>` : ''}
    <p class="pers-note">Межі мікрорайонів — з <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener">OpenStreetMap</a>
    (© учасники OpenStreetMap). Будинки, яких немає на карті, віднесено за сусідніми номерами тієї ж вулиці${state.distUnknown ? `; не вдалося віднести ${state.distUnknown} адрес` : ''}.
    Вулиці без номерів — до мікрорайонів, через які вони проходять.</p>`;
}

function renderDistricts() {
  const box = $('#districts');
  const sel = [...state.distSel].map((id) => state.dist.get(id)).filter(Boolean);
  if (!state.data || !sel.length) { box.hidden = true; box.innerHTML = ''; return; }
  const sch = schedule(state.date);
  const now = kyivNow();
  const today = state.date === now.date;
  const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.did));
  const cards = sel.map((d) => {
    const qids = [...d.qids.keys()].sort((a, b) => state.order[a] - state.order[b]);
    const sts = today ? qids.map((q) => statusFor(rowVals(state.date, q), now.minutes)) : [];
    const offNow = sts.filter((s) => s.cls === 'off').length;
    const head = today
      ? (offNow ? `зараз без світла: <b>${offNow} з ${qids.length}</b> підчерг` : `<b>зараз світло скрізь є</b> · ${qids.length} підчерг`)
      : `${qids.length} підчерг`;
    const rows = qids.map((qid, i) => {
      const x = d.qids.get(qid);
      const vals = sch?.rows[qid];
      const n = [...x.houses.values()].reduce((a, b) => a + b.size, 0);
      const cells = vals ? vals.map((v) => `<i class="c v${v ?? 'x'}"></i>`).join('') : '';
      const cnt = n ? `${n} буд.` : x.whole.size ? `${x.whole.size} вул.` : x.objects.size ? `${x.objects.size} об’єкт.` : '';
      return `<div class="dist-row"><span class="dr-q"><i class="${today ? sts[i].cls : ''}"></i>${esc(qid)}</span>
        <div class="hm-cells">${cells}</div><span class="dr-n">${esc(cnt)}</span>
        <span class="dr-t">${esc(vals ? winsText(vals) : 'немає графіка')}</span></div>`;
    }).join('');
    const det = qids.map((qid) => {
      const x = d.qids.get(qid);
      const parts = [...x.houses].map(([st, hs]) => `${esc(st)} ${esc(sortHouses([...hs]).join(', '))}`);
      if (x.whole.size) parts.push(`${[...x.whole].map(esc).join(', ')} <span class="muted">(вулиця загалом)</span>`);
      if (x.objects.size) parts.push(`<span class="muted">${[...x.objects].map(esc).join(', ')}</span>`);
      return `<li><b>${esc(qid)}</b>: ${parts.join('; ')}</li>`;
    }).join('');
    return `<article class="dist"><div class="dist-head"><h3>${esc(d.name)}</h3><span class="dist-now">${head}</span></div>
      ${rows}<details data-did="${esc(d.id)}"${open.has(d.id) ? ' open' : ''}><summary>Які будинки в якій підчерзі</summary><ul class="dl">${det}</ul></details></article>`;
  }).join('');
  box.hidden = false;
  box.className = `districts${today ? ' today' : ''}`;
  box.style.setProperty('--now', (now.minutes / 1440).toFixed(4));
  box.innerHTML = `<div class="sec-head"><h2>Мої мікрорайони · ${ddmm(state.date)}</h2>
    <a href="#personal" class="link">змінити</a></div>${cards}`;
}

/* ===================== віджет на телефон ===================== */

const WIDGET_KEY = 'gpv.widget';
const APK_URL = 'https://github.com/raitodano/koly-svitlo/releases/latest/download/KolySvitlo.apk';
const SCRIPTABLE_URL = 'scriptable/KolySvitlo.js';
const bridge = () => window.KolySvitloApp || null; // міст з Android-застосунку «Коли світло?»
state.widget = readJson(WIDGET_KEY, null);

function appState() {
  const app = bridge();
  if (!app) return null;
  try { return JSON.parse(app.getState()); } catch { return null; }
}

/** Адреси, які можна поставити у віджет: поточний пошук, «Мої адреси», історія. */
function widgetCandidates() {
  const out = [], seen = new Set();
  const add = (title, loc, qids, from) => {
    if (!title || !qids?.length || seen.has(title)) return;
    seen.add(title);
    out.push({ title, loc: loc || '', qids, from });
  };
  if (state.query.trim() && state.cards[0] && state.lastRes) {
    const g = state.cards[0];
    const h = shownHouse(g, state.lastRes.house);
    add(`${cardTitle(g)}${h ? ', ' + h : ''}`, displayEntry(g.hits).loc, qidsOf(g), 'пошук');
  }
  for (const m of state.mine) {
    if (m.kind === 'manual') add(m.title, m.loc, [m.qid], 'мої адреси');
    else {
      const g = search(m.q).cards.find((c) => c.id === m.id);
      if (g) add(m.title, displayEntry(g.hits).loc, qidsOf(g), 'мої адреси');
    }
  }
  for (const h of state.hist) add(h.title, h.loc, h.qids, 'історія');
  if (state.widget) add(state.widget.title, state.widget.loc, state.widget.qids, 'віджет');
  return out;
}

const widgetParam = (w) => `${w.qids.join(',')}|${w.title}`;

/** Як виглядатиме віджет зараз (той самий розрахунок, що й у застосунку/скрипті). */
function widgetPreviewHtml(w) {
  const now = kyivNow();
  const sts = w.qids.map((q) => statusFor(rowVals(now.date, q), now.minutes));
  const st = sts.find((s) => s.cls === 'off') || sts.find((s) => s.cls === 'maybe') || sts.find((s) => s.cls === 'on') || sts[0];
  const vals = rowVals(now.date, w.qids[0]);
  const cells = vals ? vals.map((v) => `<i class="c v${v ?? 'x'}"></i>`).join('') : '';
  return `<div class="wg-preview ${st.cls}"><span class="wg-addr">${esc(w.title)}</span>
    <span class="wg-big">${esc(st.big)}</span><span class="wg-small">${esc(st.small)}${w.qids.length > 1 ? ` · ${esc(w.qids.join(', '))}` : ` · ${esc(w.qids[0])}`}</span>
    <div class="hm-cells">${cells}</div></div>`;
}

function renderWidgetBox() {
  const box = $('#widget-box');
  if (!box || !state.data) return;
  const cands = widgetCandidates();
  const w = state.widget;
  const opts = cands.map((c, i) => `<option value="${i}"${w && c.title === w.title ? ' selected' : ''}>${esc(c.title)} — ${esc(c.qids.join(', '))}</option>`).join('');
  const pick = `<div class="wg-pick">
    <label>Адреса для віджета<select id="wg-select"><option value="">— оберіть —</option>${opts}</select></label>
    ${cands.length ? '' : '<p class="pers-note">Спершу знайдіть свою адресу в пошуку — вона з’явиться тут (а також адреси з історії та «Моїх адрес»).</p>'}
    ${w ? widgetPreviewHtml(w) : ''}
    ${w ? `<div class="wg-param"><code id="wg-param">${esc(widgetParam(w))}</code><button type="button" class="btn" data-copy-param>Копіювати</button></div>
      <p class="pers-note">Цей рядок — «Parameter» для віджета на iPhone.</p>` : ''}
  </div>`;

  let how;
  const as = appState();
  if (as) {
    const inWidget = as.title ? `У віджеті зараз: <b>${esc(as.title)}</b> (${esc((as.qids || []).join(', '))})` : 'Адресу для віджета ще не обрано.';
    const perm = [];
    if (as.notify && as.canNotify === false) perm.push('сповіщення заборонені в налаштуваннях телефона');
    if (as.notify && as.canExact === false) perm.push('немає дозволу на точні нагадування — сповіщення можуть запізнюватися');
    how = `<div class="os"><h4>Цей застосунок</h4>
      <div class="app-state">${inWidget}${as.lastFetch ? `<br><span class="muted">Графік оновлено ${esc(whenKyiv(as.lastFetch))}</span>` : ''}</div>
      <p><button type="button" class="btn" data-app-set${w ? '' : ' disabled'}>Показувати у віджеті</button></p>
      <label class="toggle"><input type="checkbox" id="app-notify"${as.notify ? ' checked' : ''}>
        <span>Сповіщати на початку помаранчевої півгодинки — приблизно за 30 хв до того, як не стане світла</span></label>
      <label class="toggle"><input type="checkbox" id="app-maybe"${as.notifyMaybe ? ' checked' : ''}>
        <span>Також попереджати про можливі відключення (смугасті)</span></label>
      ${perm.length ? `<p class="pers-note">⚠ ${esc(perm.join('; '))}. <button type="button" class="link" data-app-perm>Відкрити дозволи</button></p>` : ''}
      <ol class="steps"><li>Оберіть адресу ліворуч і натисніть «Показувати у віджеті».</li>
        <li>Довге натискання на порожньому місці головного екрана → «Віджети» → «Коли світло?».</li></ol></div>`;
  } else {
    how = `<div>
      <div class="os" style="border:0;margin:0;padding:0"><h4>Android</h4><ol class="steps">
        <li>Завантажте <a href="${APK_URL}">KolySvitlo.apk</a> і встановіть (телефон спитає дозвіл на встановлення з браузера).</li>
        <li>Відкрийте «Коли світло?», знайдіть адресу й у «Персоналізації» натисніть «Показувати у віджеті», увімкніть сповіщення.</li>
        <li>Довге натискання на головному екрані → «Віджети» → «Коли світло?». Натискання на віджет відкриває цей сайт.</li></ol></div>
      <div class="os"><h4>iPhone</h4><ol class="steps">
        <li>Встановіть безкоштовний застосунок <a href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" rel="noopener">Scriptable</a>.</li>
        <li>Відкрийте <a href="${SCRIPTABLE_URL}" target="_blank" rel="noopener">скрипт віджета</a>, скопіюйте весь текст; у Scriptable — «+», вставте, назвіть «Коли світло». Запустіть один раз ▶ і дозвольте сповіщення.</li>
        <li>Додайте на екран «Додому» віджет Scriptable, торкніться його в режимі редагування: Script — «Коли світло», Parameter — рядок ліворуч.</li></ol></div>
      <div class="os"><h4>Просто значок</h4><p class="pers-note" style="margin:0">Меню браузера → «Додати на головний екран»: значок відкриває цей сайт (без статусу й сповіщень — сайт сам їх надсилати не може).</p></div>
    </div>`;
  }
  box.innerHTML = `<div class="wg-grid">${pick}${how}</div>`;
  box._cands = cands;
}

/* ===================== загальний рендер ===================== */

function renderAll() {
  renderDays();
  renderResults();
  renderOverview();
  renderDistricts();
  renderSync();
  tickClock();
  if (isPersonal()) { renderDistPick(); renderWidgetBox(); }
}

function tickClock() { $('#clock').textContent = kyivNow().hhmm; }

/** Щопівхвилини оновлюємо «зараз» без повного перерендеру (щоб не закривались розгорнуті списки). */
function tick() {
  tickClock();
  if (!state.data) return;
  const now = kyivNow();
  const slot = Math.floor(now.minutes / 30);
  if (slot !== state.lastSlot) { // крапки «є/немає світла» в історії та мікрорайонах
    state.lastSlot = slot;
    renderHistory();
    renderDistricts();
    if (isPersonal()) renderWidgetBox();
  }
  renderSyncText();
  $('#districts').style.setProperty('--now', (now.minutes / 1440).toFixed(4));
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
  $('.hm')?.style.setProperty('--now', (now.minutes / 1440).toFixed(4));
}

/* ===================== дані ===================== */

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  let d;
  try { d = await r.json(); } catch { throw new Error(`сервер відповів HTTP ${r.status}`); }
  if (!r.ok || !d.schedules) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const sig = (x) => JSON.stringify([x.schedules.map((s) => s.date + s.saved_at), x.queues.map((q) => q.rows.map((w) => w.text))]);

/** Прийняти нові дані; перемальовуємо лише якщо щось змінилося (щоб не згортати відкриті списки). */
function applyData(d) {
  if (STATIC_MODE && state.live) d.schedules = mergeSchedules(d.schedules, state.live.schedules);
  const firstLoad = !state.data;
  if (!firstLoad && sig(d) === sig(state.data)) {
    Object.assign(state.data, { fetched_at: d.fetched_at, stale: d.stale, error: d.error });
    renderSync();
    return;
  }
  const queuesChanged = firstLoad || JSON.stringify(d.queues.map((q) => q.rows.map((w) => w.text))) !== JSON.stringify(state.data.queues.map((q) => q.rows.map((w) => w.text)));
  state.data = d;
  state.order = Object.fromEntries(d.subqueues.map((q, i) => [q, i]));
  if (queuesChanged) {
    state.index = buildIndex(d);
    state.best = buildBest(state.index);
    buildDistricts();
  }
  const dates = d.schedules.map((s) => s.date);
  const today = kyivNow().date;
  if (firstLoad || !dates.includes(state.date)) state.date = dates.includes(today) ? today : dates[0];
  renderAll();
}

async function load() {
  if (!state.data) $('#results').innerHTML = '<div class="skeleton"></div>';
  try {
    const d = await fetchJson(STATIC_MODE ? `${DATA_URL}?t=${Date.now()}` : DATA_URL);
    applyData(d);
    $('#notice').hidden = true;
  } catch (err) {
    if (!state.data) {
      $('#results').innerHTML = `<div class="notice">Не вдалося завантажити графіки: ${esc(err.message)}
        <button type="button" id="retry">Спробувати ще</button></div>`;
    }
  }
  maybeAutoVerify();
}

/* ===================== події ===================== */

let debounce, histTimer;
const input = $('#q');
function setQuery(v) {
  state.query = v;
  try { localStorage.setItem('gpv.q', v); } catch { /* приватний режим */ }
  renderResults();
  renderOverview();
  clearTimeout(histTimer);
  histTimer = setTimeout(() => commitHistory('idle'), HIST_IDLE_MS);
}
input.addEventListener('input', () => {
  state.focusId = null;
  leavePersonal();
  clearTimeout(debounce);
  debounce = setTimeout(() => setQuery(input.value), 120);
});
input.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  clearTimeout(debounce);
  if (input.value !== state.query) setQuery(input.value);
  clearTimeout(histTimer);
  commitHistory('enter');
  input.blur(); // ховає клавіатуру на телефоні
});
input.addEventListener('blur', () => { clearTimeout(histTimer); commitHistory('blur'); });

function runQuery(q, focusId = null) {
  leavePersonal();
  input.value = q;
  state.focusId = focusId;
  setQuery(q);
  setDrawer(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleQueue(qid) {
  if (state.openQ.has(qid)) state.openQ.delete(qid); else state.openQ.add(qid);
  renderOverview();
  $(`.hm-row[data-sq="${CSS.escape(qid)}"]`)?.focus({ preventScroll: true });
}

document.addEventListener('click', (ev) => {
  const t = ev.target;
  const ex = t.closest('[data-q]');
  if (ex) { runQuery(ex.dataset.q, ex.dataset.focus || null); if (!ex.closest('.overview')) input.focus(); return; }
  const hg = t.closest('[data-hist]');
  if (hg) {
    const h = state.hist.find((x) => x.uid === hg.dataset.hist);
    if (h) {
      h.t = Date.now();
      state.hist = [h, ...state.hist.filter((x) => x !== h)];
      saveHist();
      state.lastCommit = null;
      runQuery(h.q, h.id);
    }
    return;
  }
  const hd = t.closest('[data-hist-del]');
  if (hd) { state.hist = state.hist.filter((x) => x.uid !== hd.dataset.histDel); saveHist(); renderHistory(); return; }
  if (t.closest('#hist-clear')) { state.hist = []; saveHist(); renderHistory(); return; }
  if (t.closest('#hist-toggle')) { setDrawer(!document.body.classList.contains('side-open')); return; }
  if (t.closest('#side-close, #side-backdrop')) { setDrawer(false); return; }
  const row = t.closest('.hm-row[data-sq]');
  if (row) { toggleQueue(row.dataset.sq); return; }
  const day = t.closest('#days [data-date]');
  if (day) { state.date = day.dataset.date; renderAll(); return; }
  if (t.closest('#verify, [data-verify]')) { verify(false); return; }
  if (t.closest('[data-vclose]')) { state.vres = null; renderSync(); return; }
  const save = t.closest('[data-save]');
  if (save) {
    const existing = savedFound(save.dataset.save);
    if (existing) state.mine = state.mine.filter((m) => m !== existing);
    else {
      const g = state.cards.find((c) => c.id === save.dataset.save);
      if (g) {
        const h = shownHouse(g, state.lastRes?.house);
        state.mine.push({ uid: uid(), kind: 'found', id: g.id, q: state.query.trim(), title: `${cardTitle(g)}${h ? ', ' + h : ''}` });
      }
    }
    saveMine();
    commitHistory('click', save.dataset.save);
    renderResults();
    return;
  }
  const rm = t.closest('[data-remove]');
  if (rm) {
    state.mine = state.mine.filter((m) => m.uid !== rm.dataset.remove);
    saveMine();
    renderResults();
    return;
  }
  if (t.closest('#retry')) { load(); return; }
  const card = t.closest('article.card[data-gid]');
  if (card) commitHistory('click', card.dataset.gid);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && document.body.classList.contains('side-open')) { setDrawer(false); return; }
  const row = ev.target.closest?.('.hm-row[data-sq]');
  if (row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleQueue(row.dataset.sq); }
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

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });

/* --- Персоналізація --- */
window.addEventListener('hashchange', renderView);

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.name === 'theme') { applyTheme(t.value); return; }
  if (t.dataset?.dist) {
    if (t.checked) state.distSel.add(t.dataset.dist); else state.distSel.delete(t.dataset.dist);
    writeJson(DIST_KEY, [...state.distSel]);
    renderDistricts();
    return;
  }
  if (t.id === 'wg-select') {
    const c = $('#widget-box')._cands?.[+t.value];
    state.widget = t.value === '' || !c ? null : { title: c.title, loc: c.loc, qids: c.qids };
    writeJson(WIDGET_KEY, state.widget);
    renderWidgetBox();
    return;
  }
  if ((t.id === 'app-notify' || t.id === 'app-maybe') && bridge()) {
    bridge().setNotify($('#app-notify').checked, $('#app-maybe').checked);
    setTimeout(renderWidgetBox, 600); // застосунок міг спитати дозвіл на сповіщення
  }
});

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('#pers-back')) { leavePersonal(); return; }
  if (t.closest('[data-copy-param]')) {
    const text = $('#wg-param')?.textContent || '';
    const done = () => { t.closest('button').textContent = 'Скопійовано ✓'; };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => selectText($('#wg-param')));
    else selectText($('#wg-param'));
    return;
  }
  if (t.closest('[data-app-set]') && bridge() && state.widget) {
    bridge().setAddress(JSON.stringify(state.widget));
    setTimeout(renderWidgetBox, 300);
    return;
  }
  if (t.closest('[data-app-perm]') && bridge()) bridge().openPermissions();
});

function selectText(el) {
  if (!el) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// висота шапки — щоб історія ліворуч «прилипала» одразу під нею
const mast = $('#mast');
const setMastH = () => document.documentElement.style.setProperty('--mast-h', `${mast.offsetHeight}px`);
if ('ResizeObserver' in window) new ResizeObserver(setMastH).observe(mast);
setMastH();

try { input.value = localStorage.getItem('gpv.q') || ''; } catch { /* ignore */ }
// посилання з віджета: ?q=бульвар Шевченка, 10 — одразу показати цю адресу
const urlQ = new URLSearchParams(location.search).get('q');
if (urlQ) input.value = urlQ.slice(0, 120);
state.query = input.value;
applyTheme(currentTheme());
tickClock();
renderHistory();
renderSync();
renderView();
load().then(loadDistricts);
setInterval(load, REFRESH_MS);
setInterval(tick, 30 * 1000);
