// Cloudflare Worker: броні парт, домашка, опитування й чат класу в Durable Object (SQLite).
// Якщо поруч є public/ (binding ASSETS), віддає і сам сайт; інакше лише API для сторінки на GitHub Pages.
//
//   GET  /api/sync?dates=…&from=…&to=…&chat=<останній id>&rev=<версія чату>
//        → { days, hw, polls, chat: { rev, full, msgs } } — усе, що сторінка оновлює раз на кілька секунд
//   POST /api/book          { date, seat, name }        409 { code: 'taken' }; 400 { code: 'date' } — не напередодні
//   POST /api/release       { date }
//   POST /api/hw            { date, lesson, text, name } порожній text стирає запис
//   GET  /api/hw/history?date=…&lesson=…              попередні версії, новіші першими
//   POST /api/polls         { q, options, name }
//   POST /api/polls/vote    { id, option }               option = null знімає голос
//   POST /api/polls/delete  { id }                       автор або староста
//   POST /api/chat          { text, name }
//   POST /api/chat/delete   { id }                       автор або староста
//   POST /api/chat/react    { id, emoji }                поставити / зняти реакцію (👍 😂 ❤️ 🔥)
//   GET  /api/admin                                      { admin } — чи правильний код старости
//   POST /api/admin/release { date, seat }               староста знімає будь-яку бронь
//   POST /api/admin/hw-history-clear { date, lesson }
//
// Хто є хто — випадковий токен пристрою в заголовку x-token; у базі лежить лише його SHA-256.
// Код старости — заголовок x-admin; у коді лежить лише його SHA-256.
// Імена назовні віддаються скорочено: «Нестор Гуцалік» → «Нестор Г.».
import { DurableObject } from 'cloudflare:workers';

const ADMIN_HASH = 'a3f2a5c657e26bb0a9ecf957112c2c519b46f4b3b6d620da46a07e4b32a4bffc';
const ROWS = 3, DESKS = 5;
// бронюється вся парта: «ряд-парта»
const SEAT = new RegExp(`^[1-${ROWS}]-[1-${DESKS}]$`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 864e5;
const POLL_DAYS = 14;        // опитування видно 2 тижні
const POLLS_PER_PERSON = 3;  // відкритих опитувань від однієї людини
const CHAT_DAYS = 7;         // повідомлення видно тиждень
const CHAT_PAGE = 100;
const REACTIONS = ['👍', '😂', '❤️', '🔥'];

// Обмеження частоти записів, щоб один скрипт не забив сайт і безкоштовний ліміт Cloudflare.
const LIMITS = {
  owner: [30, 60e3],        // записів за хвилину з одного пристрою
  ip: [150, 60e3],          // з однієї адреси (у школі весь клас за одним Wi-Fi)
  ownersPerIp: [35, 36e5],  // різних «людей» з однієї адреси за годину — трохи більше, ніж учнів у класі
  chat: [12, 60e3],         // повідомлень за хвилину від однієї людини
};

// Сторінка лежить на іншому сайті (GitHub Pages), тому API відкрите для всіх джерел.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-token, x-admin',
  'access-control-max-age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
});
const fail = (code, status = 400) => json({ error: code, code }, status);
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const shortName = name => { const [a, b] = String(name).split(' '); return b ? `${a} ${b[0]}.` : a; };

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const ms = date => Date.parse(date + 'T00:00:00Z');
const weekday = t => { const d = new Date(t).getUTCDay(); return d >= 1 && d <= 5; };
// Бронювати парту можна лише напередодні: від попереднього навчального дня (на понеділок — з пʼятниці)
// і до початку самого дня.
function bookable(date) {
  if (!DATE.test(date)) return false;
  const t = ms(date), today = ms(kyivToday());
  if (!weekday(t) || t <= today) return false;
  let prev = t - DAY;
  while (!weekday(prev)) prev -= DAY;
  return today >= prev;
}
// звільнити свою парту можна й у сам день
const releasable = date => DATE.test(date) && weekday(ms(date)) && ms(date) >= ms(kyivToday());
// домашку можна писати на 4 тижні вперед і правити за 2 тижні назад
function hwDate(date) {
  if (!DATE.test(date)) return false;
  const t = ms(date), today = ms(kyivToday());
  return weekday(t) && t >= today - 14 * DAY && t <= today + 28 * DAY;
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bookings (
      date TEXT NOT NULL, seat TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (date, seat), UNIQUE (date, owner))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS homework (
      date TEXT NOT NULL, lesson INTEGER NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (date, lesson))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS homework_history (
      date TEXT NOT NULL, lesson INTEGER NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT NOT NULL, options TEXT NOT NULL, by TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS votes (
      poll INTEGER NOT NULL, owner TEXT NOT NULL, option INTEGER NOT NULL, PRIMARY KEY (poll, owner))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, by TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reactions (
      msg INTEGER NOT NULL, owner TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (msg, owner, emoji))`);
    // колись бронювали окремі місця («1-2-L»); тепер — цілі парти
    this.sql.exec("DELETE FROM bookings WHERE seat LIKE '%-L' OR seat LIKE '%-R'");
    this.hits = new Map();
    this.ipOwners = new Map();
  }

  // ---------- обмеження частоти ----------
  over(key, [max, windowMs]) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.t > windowMs) this.hits.set(key, (e = { t: now, n: 0 }));
    if (this.hits.size > 20000) this.hits.clear();
    return ++e.n > max;
  }
  // true — запит треба відхилити
  limited(who, kind) {
    if (who.admin) return false;
    if (this.over(`o:${who.owner}`, LIMITS.owner) || this.over(`i:${who.ip}`, LIMITS.ip)) return true;
    if (kind === 'chat' && this.over(`c:${who.owner}`, LIMITS.chat)) return true;
    // скільки різних пристроїв пише з однієї адреси за годину
    const now = Date.now();
    let e = this.ipOwners.get(who.ip);
    if (!e || now - e.t > LIMITS.ownersPerIp[1]) this.ipOwners.set(who.ip, (e = { t: now, set: new Set() }));
    if (this.ipOwners.size > 5000) this.ipOwners.clear();
    // тих, хто вже писав з цієї адреси, не блокуємо — інакше скрипт зупинив би весь шкільний Wi-Fi
    if (e.set.has(who.owner)) return false;
    if (e.set.size >= LIMITS.ownersPerIp[0]) return true;
    e.set.add(who.owner);
    return false;
  }

  // ---------- читання для сторінки ----------
  sync(q, owner) {
    return {
      days: Object.fromEntries(q.dates.map(d => [d, this.day(d, owner)])),
      hw: q.from && q.to ? this.hw(q.from, q.to) : {},
      polls: this.polls(owner),
      chat: this.chat(q.chat, q.rev, owner),
    };
  }

  day(date, owner) {
    const seats = {};
    let mine = null;
    for (const r of this.sql.exec('SELECT seat, name, owner FROM bookings WHERE date = ?', date)) {
      seats[r.seat] = { name: shortName(r.name) };
      if (r.owner === owner) mine = r.seat;
    }
    return { seats, mine };
  }

  hw(from, to) {
    const out = {};
    for (const r of this.sql.exec('SELECT date, lesson, text, by, at FROM homework WHERE date >= ? AND date <= ?', from, to)) {
      out[`${r.date}|${r.lesson}`] = { text: r.text, by: shortName(r.by), at: r.at };
    }
    return out;
  }

  hwHistory(date, lesson) {
    return this.sql.exec('SELECT text, by, at FROM homework_history WHERE date = ? AND lesson = ? ORDER BY at DESC LIMIT 20', date, lesson)
      .toArray().map(r => ({ ...r, by: shortName(r.by) }));
  }

  polls(owner) {
    const since = Date.now() - POLL_DAYS * DAY;
    return this.sql.exec('SELECT id, q, options, by, owner, at FROM polls WHERE at >= ? ORDER BY at DESC LIMIT 30', since).toArray().map(p => {
      const options = JSON.parse(p.options), counts = options.map(() => 0);
      let mine = null;
      for (const v of this.sql.exec('SELECT owner, option FROM votes WHERE poll = ?', p.id)) {
        if (counts[v.option] != null) counts[v.option]++;
        if (v.owner === owner) mine = v.option;
      }
      return { id: p.id, q: p.q, options, counts, total: counts.reduce((a, b) => a + b, 0), mine, by: shortName(p.by), at: p.at, own: p.owner === owner };
    });
  }

  chatRev() {
    return this.sql.exec("SELECT value FROM meta WHERE key = 'chat_rev'").toArray()[0]?.value ?? 0;
  }
  // нові повідомлення після after; якщо щось видалили (змінилась версія) — останні CHAT_PAGE повністю
  chat(after, rev, owner) {
    const cur = this.chatRev(), full = !after || rev !== cur;
    const since = Date.now() - CHAT_DAYS * DAY;
    const rows = full
      ? this.sql.exec('SELECT id, text, by, owner, at FROM chat WHERE at >= ? ORDER BY id DESC LIMIT ?', since, CHAT_PAGE).toArray().reverse()
      : this.sql.exec('SELECT id, text, by, owner, at FROM chat WHERE id > ? ORDER BY id LIMIT ?', after, CHAT_PAGE).toArray();
    const react = {};
    if (rows.length) {
      for (const r of this.sql.exec('SELECT msg, owner, emoji FROM reactions WHERE msg >= ?', rows[0].id)) {
        const e = ((react[r.msg] ||= {})[r.emoji] ||= { n: 0, mine: false });
        e.n++;
        if (r.owner === owner) e.mine = true;
      }
    }
    return { rev: cur, full, msgs: rows.map(m => ({ id: m.id, text: m.text, by: shortName(m.by), at: m.at, own: m.owner === owner, re: react[m.id] || {} })) };
  }

  bumpChat() {
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('chat_rev', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1");
  }

  // ---------- записи (усі проходять через обмеження частоти) ----------
  act(action, a, who) {
    if (this.limited(who, action === 'chat' ? 'chat' : 'write')) return { error: 'slow' };
    const owner = who.owner;
    switch (action) {
      case 'book': {
        const cur = this.sql.exec('SELECT owner FROM bookings WHERE date = ? AND seat = ?', a.date, a.seat).toArray()[0];
        if (cur && cur.owner !== owner) return { error: 'taken' };
        // одна парта на людину на день: стара звільняється
        this.sql.exec('DELETE FROM bookings WHERE date = ? AND owner = ?', a.date, owner);
        this.sql.exec('INSERT INTO bookings (date, seat, name, owner, created) VALUES (?, ?, ?, ?, ?)', a.date, a.seat, a.name, owner, Date.now());
        this.cleanup();
        return { day: this.day(a.date, owner) };
      }
      case 'release':
        this.sql.exec('DELETE FROM bookings WHERE date = ? AND owner = ?', a.date, owner);
        return { day: this.day(a.date, owner) };
      case 'adminRelease':
        if (!who.admin) return { error: 'admin' };
        this.sql.exec('DELETE FROM bookings WHERE date = ? AND seat = ?', a.date, a.seat);
        return { day: this.day(a.date, owner) };
      case 'hw': {
        // попередня версія йде в історію, щоб зіпсований запис можна було повернути
        const old = this.sql.exec('SELECT text, by, at FROM homework WHERE date = ? AND lesson = ?', a.date, a.lesson).toArray()[0];
        if (old && old.text !== a.text) {
          this.sql.exec('INSERT INTO homework_history (date, lesson, text, by, at) VALUES (?, ?, ?, ?, ?)', a.date, a.lesson, old.text, old.by, old.at);
          // у історії тримаємо не більше 30 версій на урок
          this.sql.exec(`DELETE FROM homework_history WHERE date = ? AND lesson = ? AND at NOT IN
            (SELECT at FROM homework_history WHERE date = ? AND lesson = ? ORDER BY at DESC LIMIT 30)`, a.date, a.lesson, a.date, a.lesson);
        }
        if (!a.text) this.sql.exec('DELETE FROM homework WHERE date = ? AND lesson = ?', a.date, a.lesson);
        else this.sql.exec(`INSERT INTO homework (date, lesson, text, by, owner, at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (date, lesson) DO UPDATE SET text = excluded.text, by = excluded.by, owner = excluded.owner, at = excluded.at`,
          a.date, a.lesson, a.text, a.name, owner, Date.now());
        return { hw: this.hw(a.date, a.date) };
      }
      case 'hwHistoryClear':
        if (!who.admin) return { error: 'admin' };
        this.sql.exec('DELETE FROM homework_history WHERE date = ? AND lesson = ?', a.date, a.lesson);
        return { history: [] };
      case 'poll': {
        const open = this.sql.exec('SELECT COUNT(*) AS n FROM polls WHERE owner = ? AND at >= ?', owner, Date.now() - POLL_DAYS * DAY).one().n;
        if (open >= POLLS_PER_PERSON && !who.admin) return { error: 'limit' };
        this.sql.exec('INSERT INTO polls (q, options, by, owner, at) VALUES (?, ?, ?, ?, ?)', a.q, JSON.stringify(a.options), a.name, owner, Date.now());
        this.cleanup();
        return { polls: this.polls(owner) };
      }
      case 'vote': {
        const p = this.sql.exec('SELECT options, at FROM polls WHERE id = ?', a.id).toArray()[0];
        if (!p || p.at < Date.now() - POLL_DAYS * DAY) return { error: 'poll' };
        if (a.option == null) this.sql.exec('DELETE FROM votes WHERE poll = ? AND owner = ?', a.id, owner);
        else {
          if (!Number.isInteger(a.option) || a.option < 0 || a.option >= JSON.parse(p.options).length) return { error: 'option' };
          this.sql.exec(`INSERT INTO votes (poll, owner, option) VALUES (?, ?, ?)
            ON CONFLICT (poll, owner) DO UPDATE SET option = excluded.option`, a.id, owner, a.option);
        }
        return { polls: this.polls(owner) };
      }
      case 'pollDelete': {
        const p = this.sql.exec('SELECT owner FROM polls WHERE id = ?', a.id).toArray()[0];
        if (!p) return { error: 'poll' };
        if (p.owner !== owner && !who.admin) return { error: 'owner' };
        this.sql.exec('DELETE FROM votes WHERE poll = ?', a.id);
        this.sql.exec('DELETE FROM polls WHERE id = ?', a.id);
        return { polls: this.polls(owner) };
      }
      case 'chat':
        this.sql.exec('INSERT INTO chat (text, by, owner, at) VALUES (?, ?, ?, ?)', a.text, a.name, owner, Date.now());
        this.cleanup();
        return { ok: true };
      case 'chatDelete': {
        const m = this.sql.exec('SELECT owner FROM chat WHERE id = ?', a.id).toArray()[0];
        if (!m) return { error: 'msg' };
        if (m.owner !== owner && !who.admin) return { error: 'owner' };
        this.sql.exec('DELETE FROM chat WHERE id = ?', a.id);
        this.sql.exec('DELETE FROM reactions WHERE msg = ?', a.id);
        this.bumpChat();
        return { ok: true };
      }
      case 'react': {
        if (!this.sql.exec('SELECT id FROM chat WHERE id = ?', a.id).toArray().length) return { error: 'msg' };
        const had = this.sql.exec('SELECT 1 FROM reactions WHERE msg = ? AND owner = ? AND emoji = ?', a.id, owner, a.emoji).toArray().length;
        if (had) this.sql.exec('DELETE FROM reactions WHERE msg = ? AND owner = ? AND emoji = ?', a.id, owner, a.emoji);
        else this.sql.exec('INSERT INTO reactions (msg, owner, emoji) VALUES (?, ?, ?)', a.id, owner, a.emoji);
        // реакції змінюють старі повідомлення — сторінки перечитають чат повністю
        this.bumpChat();
        return { ok: true };
      }
    }
    return { error: 'not_found' };
  }

  cleanup() {
    const old = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM bookings WHERE date < ?', old);
    this.sql.exec('DELETE FROM homework WHERE date < ?', old);
    this.sql.exec('DELETE FROM homework_history WHERE date < ?', old);
    const oldPolls = Date.now() - 60 * DAY;
    this.sql.exec('DELETE FROM votes WHERE poll IN (SELECT id FROM polls WHERE at < ?)', oldPolls);
    this.sql.exec('DELETE FROM polls WHERE at < ?', oldPolls);
    this.sql.exec('DELETE FROM reactions WHERE msg IN (SELECT id FROM chat WHERE at < ?)', Date.now() - CHAT_DAYS * DAY);
    this.sql.exec('DELETE FROM chat WHERE at < ?', Date.now() - CHAT_DAYS * DAY);
  }
}

// Перший фільтр ще до бази: у межах одного екземпляра Worker не більше 240 запитів за хвилину з адреси.
const seen = new Map();
function flood(ip) {
  const now = Date.now();
  let e = seen.get(ip);
  if (!e || now - e.t > 60e3) seen.set(ip, (e = { t: now, n: 0 }));
  if (seen.size > 10000) seen.clear();
  return ++e.n > 240;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : fail('not_found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (flood(ip)) return fail('slow', 429);
    const token = request.headers.get('x-token') || '';
    if (!/^[0-9a-f]{32}$/.test(token)) return fail('token', 401);
    const adminKey = request.headers.get('x-admin') || '';
    const who = { owner: await sha256(token), ip, admin: !!adminKey && (await sha256(adminKey)) === ADMIN_HASH };
    const board = env.BOARD.get(env.BOARD.idFromName('8b'));
    const path = url.pathname, q = url.searchParams;
    const reply = r => (r.error ? fail(r.error, r.error === 'taken' ? 409 : r.error === 'slow' ? 429 : r.error === 'admin' ? 403 : 400) : json(r));

    if (request.method === 'GET') {
      if (path === '/api/sync') {
        const dates = (q.get('dates') || '').split(',').filter(d => DATE.test(d)).slice(0, 10);
        const from = DATE.test(q.get('from') || '') ? q.get('from') : null, to = DATE.test(q.get('to') || '') ? q.get('to') : null;
        return json(await board.sync({ dates, from, to, chat: Number(q.get('chat')) || 0, rev: Number(q.get('rev')) || 0 }, who.owner));
      }
      if (path === '/api/hw/history') {
        const date = q.get('date') || '', lesson = Number(q.get('lesson'));
        if (!DATE.test(date) || !Number.isInteger(lesson)) return fail('date');
        return json({ history: await board.hwHistory(date, lesson) });
      }
      if (path === '/api/admin') return json({ admin: who.admin });
      // старі адреси для сторінок, що ще не оновились
      if (path === '/api/days') {
        const dates = (q.get('dates') || '').split(',').filter(d => DATE.test(d)).slice(0, 10);
        return json({ days: (await board.sync({ dates, chat: 0, rev: 0 }, who.owner)).days });
      }
      if (path === '/api/hw') {
        const from = q.get('from') || '', to = q.get('to') || '';
        if (!DATE.test(from) || !DATE.test(to)) return fail('date');
        return json({ hw: (await board.sync({ dates: [], from, to, chat: 0, rev: 0 }, who.owner)).hw });
      }
      if (path === '/api/polls') return json({ polls: (await board.sync({ dates: [], chat: 0, rev: 0 }, who.owner)).polls });
      return fail('not_found', 404);
    }

    if (request.method !== 'POST') return fail('method', 405);
    let body;
    try { body = await request.json(); } catch { return fail('json'); }
    const date = String(body.date || ''), name = clean(body.name, 32);
    const act = (action, args) => board.act(action, args, who).then(reply);

    switch (path) {
      case '/api/book': {
        const seat = String(body.seat || '');
        if (!bookable(date)) return fail('date');
        if (!SEAT.test(seat)) return fail('seat');
        if (name.length < 2) return fail('name');
        return act('book', { date, seat, name });
      }
      case '/api/release':
        if (!releasable(date)) return fail('date');
        return act('release', { date });
      case '/api/admin/release': {
        const seat = String(body.seat || '');
        if (!DATE.test(date) || !SEAT.test(seat)) return fail('seat');
        return act('adminRelease', { date, seat });
      }
      case '/api/hw': {
        const lesson = Number(body.lesson);
        const text = String(body.text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 600);
        if (!hwDate(date)) return fail('date');
        if (!Number.isInteger(lesson) || lesson < 1 || lesson > 12) return fail('lesson');
        if (name.length < 2) return fail('name');
        return act('hw', { date, lesson, text, name });
      }
      case '/api/admin/hw-history-clear':
        return act('hwHistoryClear', { date, lesson: Number(body.lesson) });
      case '/api/polls': {
        const question = clean(body.q, 140);
        const options = (Array.isArray(body.options) ? body.options.slice(0, 6) : []).map(o => clean(o, 60)).filter(Boolean);
        if (question.length < 3) return fail('q');
        if (options.length < 2 || new Set(options).size !== options.length) return fail('options');
        if (name.length < 2) return fail('name');
        return act('poll', { q: question, options, name });
      }
      case '/api/polls/vote':
        return act('vote', { id: Number(body.id), option: body.option == null ? null : Number(body.option) });
      case '/api/polls/delete':
        return act('pollDelete', { id: Number(body.id) });
      case '/api/chat': {
        const text = String(body.text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 500);
        if (!text) return fail('text');
        if (name.length < 2) return fail('name');
        return act('chat', { text, name });
      }
      case '/api/chat/delete':
        return act('chatDelete', { id: Number(body.id) });
      case '/api/chat/react':
        if (!REACTIONS.includes(body.emoji)) return fail('emoji');
        return act('react', { id: Number(body.id), emoji: body.emoji });
    }
    return fail('not_found', 404);
  },
};
