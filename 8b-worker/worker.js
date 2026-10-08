// Cloudflare Worker: зберігає броні парт, домашку та опитування в Durable Object (SQLite).
// Якщо поруч є public/ (binding ASSETS), віддає і сам сайт; інакше лише API для сторінки на GitHub Pages.
//   GET  /api/days?dates=2026-10-08,2026-10-09    → { days: { [date]: { seats: { "1-3": { name } }, mine } } }
//   POST /api/book    { date, seat, name }         → { day }   409 { code: 'taken' }; 400 { code: 'date' } — не напередодні
//   POST /api/release { date }                     → { day }
//   GET  /api/hw?from=2026-10-05&to=2026-10-16    → { hw: { "2026-10-09|5": { text, by, at } } }
//   POST /api/hw      { date, lesson, text, name } → { hw }   порожній text стирає запис
//   GET  /api/hw/history?date=…&lesson=…          → { history: [{ text, by, at }] } — попередні версії, новіші першими
//   GET  /api/polls                               → { polls: [{ id, q, options, counts, total, mine, by, at, own }] }
//   POST /api/polls        { q, options, name }   → { polls }
//   POST /api/polls/vote   { id, option }         → { polls }  option = null знімає голос
//   POST /api/polls/delete { id }                 → { polls }  лише автор
// Хто є хто — випадковий токен пристрою в заголовку x-token; у базі лежить лише його SHA-256.
import { DurableObject } from 'cloudflare:workers';

const ROWS = 3, DESKS = 5;
// бронюється вся парта: «ряд-парта»
const SEAT = new RegExp(`^[1-${ROWS}]-[1-${DESKS}]$`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 864e5;
const POLL_DAYS = 14;        // опитування видно 2 тижні
const POLLS_PER_PERSON = 3;  // відкритих опитувань від однієї людини

// Сторінка може лежати на іншому сайті (GitHub Pages), тому API відкрите для всіх джерел.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-token',
  'access-control-max-age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
});
const fail = (code, status = 400) => json({ error: code, code }, status);
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

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
function releasable(date) {
  return DATE.test(date) && weekday(ms(date)) && ms(date) >= ms(kyivToday());
}
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
    // колись бронювали окремі місця («1-2-L»); тепер — цілі парти
    this.sql.exec("DELETE FROM bookings WHERE seat LIKE '%-L' OR seat LIKE '%-R'");
  }

  // ---------- парти ----------
  day(date, owner) {
    const seats = {};
    let mine = null;
    for (const r of this.sql.exec('SELECT seat, name, owner FROM bookings WHERE date = ?', date)) {
      seats[r.seat] = { name: r.name };
      if (r.owner === owner) mine = r.seat;
    }
    return { seats, mine };
  }

  days(dates, owner) {
    const out = {};
    for (const d of dates) out[d] = this.day(d, owner);
    return out;
  }

  book(date, seat, name, owner) {
    const cur = this.sql.exec('SELECT owner FROM bookings WHERE date = ? AND seat = ?', date, seat).toArray()[0];
    if (cur && cur.owner !== owner) return { error: 'taken' };
    // одна парта на людину на день: стара звільняється
    this.sql.exec('DELETE FROM bookings WHERE date = ? AND owner = ?', date, owner);
    this.sql.exec('INSERT INTO bookings (date, seat, name, owner, created) VALUES (?, ?, ?, ?, ?)', date, seat, name, owner, Date.now());
    this.cleanup();
    return { day: this.day(date, owner) };
  }

  release(date, owner) {
    this.sql.exec('DELETE FROM bookings WHERE date = ? AND owner = ?', date, owner);
    return { day: this.day(date, owner) };
  }

  // ---------- домашка ----------
  hw(from, to) {
    const out = {};
    for (const r of this.sql.exec('SELECT date, lesson, text, by, at FROM homework WHERE date >= ? AND date <= ?', from, to)) {
      out[`${r.date}|${r.lesson}`] = { text: r.text, by: r.by, at: r.at };
    }
    return out;
  }

  setHw(date, lesson, text, by, owner) {
    // попередня версія йде в історію, щоб зіпсований запис можна було повернути
    const old = this.sql.exec('SELECT text, by, at FROM homework WHERE date = ? AND lesson = ?', date, lesson).toArray()[0];
    if (old && old.text !== text) {
      this.sql.exec('INSERT INTO homework_history (date, lesson, text, by, at) VALUES (?, ?, ?, ?, ?)', date, lesson, old.text, old.by, old.at);
    }
    if (!text) this.sql.exec('DELETE FROM homework WHERE date = ? AND lesson = ?', date, lesson);
    else this.sql.exec(`INSERT INTO homework (date, lesson, text, by, owner, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (date, lesson) DO UPDATE SET text = excluded.text, by = excluded.by, owner = excluded.owner, at = excluded.at`,
      date, lesson, text, by, owner, Date.now());
    return { hw: this.hw(date, date) };
  }

  hwHistory(date, lesson) {
    return this.sql.exec('SELECT text, by, at FROM homework_history WHERE date = ? AND lesson = ? ORDER BY at DESC LIMIT 20', date, lesson).toArray();
  }

  // ---------- опитування ----------
  polls(owner) {
    const since = Date.now() - POLL_DAYS * DAY;
    return this.sql.exec('SELECT id, q, options, by, owner, at FROM polls WHERE at >= ? ORDER BY at DESC LIMIT 30', since).toArray().map(p => {
      const options = JSON.parse(p.options), counts = options.map(() => 0);
      let mine = null;
      for (const v of this.sql.exec('SELECT owner, option FROM votes WHERE poll = ?', p.id)) {
        if (counts[v.option] != null) counts[v.option]++;
        if (v.owner === owner) mine = v.option;
      }
      return { id: p.id, q: p.q, options, counts, total: counts.reduce((a, b) => a + b, 0), mine, by: p.by, at: p.at, own: p.owner === owner };
    });
  }

  createPoll(q, options, by, owner) {
    const open = this.sql.exec('SELECT COUNT(*) AS n FROM polls WHERE owner = ? AND at >= ?', owner, Date.now() - POLL_DAYS * DAY).one().n;
    if (open >= POLLS_PER_PERSON) return { error: 'limit' };
    this.sql.exec('INSERT INTO polls (q, options, by, owner, at) VALUES (?, ?, ?, ?, ?)', q, JSON.stringify(options), by, owner, Date.now());
    this.cleanup();
    return { polls: this.polls(owner) };
  }

  vote(id, option, owner) {
    const p = this.sql.exec('SELECT options, at FROM polls WHERE id = ?', id).toArray()[0];
    if (!p || p.at < Date.now() - POLL_DAYS * DAY) return { error: 'poll' };
    if (option == null) this.sql.exec('DELETE FROM votes WHERE poll = ? AND owner = ?', id, owner);
    else {
      if (!Number.isInteger(option) || option < 0 || option >= JSON.parse(p.options).length) return { error: 'option' };
      this.sql.exec(`INSERT INTO votes (poll, owner, option) VALUES (?, ?, ?)
        ON CONFLICT (poll, owner) DO UPDATE SET option = excluded.option`, id, owner, option);
    }
    return { polls: this.polls(owner) };
  }

  deletePoll(id, owner) {
    const p = this.sql.exec('SELECT owner FROM polls WHERE id = ?', id).toArray()[0];
    if (!p) return { error: 'poll' };
    if (p.owner !== owner) return { error: 'owner' };
    this.sql.exec('DELETE FROM votes WHERE poll = ?', id);
    this.sql.exec('DELETE FROM polls WHERE id = ?', id);
    return { polls: this.polls(owner) };
  }

  cleanup() {
    const old = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM bookings WHERE date < ?', old);
    this.sql.exec('DELETE FROM homework WHERE date < ?', old);
    this.sql.exec('DELETE FROM homework_history WHERE date < ?', old);
    const oldPolls = Date.now() - 60 * DAY;
    this.sql.exec('DELETE FROM votes WHERE poll IN (SELECT id FROM polls WHERE at < ?)', oldPolls);
    this.sql.exec('DELETE FROM polls WHERE at < ?', oldPolls);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : fail('not_found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const token = request.headers.get('x-token') || '';
    if (!/^[0-9a-f]{32}$/.test(token)) return fail('token', 401);
    const owner = await sha256(token);
    const board = env.BOARD.get(env.BOARD.idFromName('8b'));
    const path = url.pathname, q = url.searchParams;

    if (request.method === 'GET') {
      if (path === '/api/days') {
        const dates = (q.get('dates') || '').split(',').filter(d => DATE.test(d)).slice(0, 10);
        return json({ days: await board.days(dates, owner) });
      }
      if (path === '/api/hw') {
        const from = q.get('from') || '', to = q.get('to') || '';
        if (!DATE.test(from) || !DATE.test(to)) return fail('date');
        return json({ hw: await board.hw(from, to) });
      }
      if (path === '/api/hw/history') {
        const date = q.get('date') || '', lesson = Number(q.get('lesson'));
        if (!DATE.test(date) || !Number.isInteger(lesson)) return fail('date');
        return json({ history: await board.hwHistory(date, lesson) });
      }
      if (path === '/api/polls') return json({ polls: await board.polls(owner) });
      return fail('not_found', 404);
    }

    if (request.method !== 'POST') return fail('method', 405);
    let body;
    try { body = await request.json(); } catch { return fail('json'); }
    const reply = r => (r.error ? fail(r.error, r.error === 'taken' ? 409 : 400) : json(r));

    if (path === '/api/polls') {
      const question = clean(body.q, 140), name = clean(body.name, 32);
      const options = (Array.isArray(body.options) ? body.options : []).map(o => clean(o, 60)).filter(Boolean).slice(0, 6);
      if (question.length < 3) return fail('q');
      if (options.length < 2 || new Set(options).size !== options.length) return fail('options');
      if (name.length < 2) return fail('name');
      return reply(await board.createPoll(question, options, name, owner));
    }
    if (path === '/api/polls/vote') {
      const option = body.option == null ? null : Number(body.option);
      return reply(await board.vote(Number(body.id), option, owner));
    }
    if (path === '/api/polls/delete') return reply(await board.deletePoll(Number(body.id), owner));

    const date = String(body.date || '');

    if (path === '/api/hw') {
      const lesson = Number(body.lesson);
      const text = String(body.text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 600);
      const name = clean(body.name, 32);
      if (!hwDate(date)) return fail('date');
      if (!Number.isInteger(lesson) || lesson < 1 || lesson > 12) return fail('lesson');
      if (name.length < 2) return fail('name');
      return json(await board.setHw(date, lesson, text, name, owner));
    }

    if (path === '/api/book') {
      const seat = String(body.seat || ''), name = clean(body.name, 32);
      if (!bookable(date)) return fail('date');
      if (!SEAT.test(seat)) return fail('seat');
      if (name.length < 2) return fail('name');
      return reply(await board.book(date, seat, name, owner));
    }
    if (path === '/api/release') {
      if (!releasable(date)) return fail('date');
      return json(await board.release(date, owner));
    }
    return fail('not_found', 404);
  },
};
