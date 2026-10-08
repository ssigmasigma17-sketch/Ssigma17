// Cloudflare Worker: зберігає броні парт і домашку в Durable Object (SQLite).
// Якщо поруч є public/ (binding ASSETS), віддає і сам сайт; інакше лише API для сторінки на GitHub Pages.
//   GET  /api/days?dates=2026-10-08,2026-10-09   → { days: { [date]: { seats: { "1-3-L": { name } }, mine } } }
//   POST /api/book    { date, seat, name }        → { day }   409 { code: 'taken' }
//   POST /api/release { date }                    → { day }
//   GET  /api/hw?from=2026-10-05&to=2026-10-16   → { hw: { "2026-10-09|5": { text, by, at } } }
//   POST /api/hw      { date, lesson, text, name } → { hw }   порожній text стирає запис
// Хто є хто — випадковий токен пристрою в заголовку x-token; у базі лежить лише його SHA-256.
import { DurableObject } from 'cloudflare:workers';

const ROWS = 3, DESKS = 5;
const SEAT = new RegExp(`^[1-${ROWS}]-[1-${DESKS}]-[LR]$`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// 5 навчальних днів наперед укладаються в 9 календарних (з вихідними посередині)
const MAX_AHEAD_DAYS = 9;

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

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function bookable(date) {
  if (!DATE.test(date)) return false;
  const t = Date.parse(date + 'T00:00:00Z'), today = Date.parse(kyivToday() + 'T00:00:00Z');
  const dow = new Date(t).getUTCDay();
  return dow >= 1 && dow <= 5 && t >= today && t <= today + MAX_AHEAD_DAYS * 864e5;
}
// домашку можна писати на 4 тижні вперед і правити за 2 тижні назад
function hwDate(date) {
  if (!DATE.test(date)) return false;
  const t = Date.parse(date + 'T00:00:00Z'), today = Date.parse(kyivToday() + 'T00:00:00Z');
  const dow = new Date(t).getUTCDay();
  return dow >= 1 && dow <= 5 && t >= today - 14 * 864e5 && t <= today + 28 * 864e5;
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
  }

  hw(from, to) {
    const out = {};
    for (const r of this.sql.exec('SELECT date, lesson, text, by, at FROM homework WHERE date >= ? AND date <= ?', from, to)) {
      out[`${r.date}|${r.lesson}`] = { text: r.text, by: r.by, at: r.at };
    }
    return out;
  }

  setHw(date, lesson, text, by, owner) {
    if (!text) this.sql.exec('DELETE FROM homework WHERE date = ? AND lesson = ?', date, lesson);
    else this.sql.exec(`INSERT INTO homework (date, lesson, text, by, owner, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (date, lesson) DO UPDATE SET text = excluded.text, by = excluded.by, owner = excluded.owner, at = excluded.at`,
      date, lesson, text, by, owner, Date.now());
    return { hw: this.hw(date, date) };
  }

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
    // одне місце на людину на день: старе звільняється
    this.sql.exec('DELETE FROM bookings WHERE date = ? AND owner = ?', date, owner);
    this.sql.exec('INSERT INTO bookings (date, seat, name, owner, created) VALUES (?, ?, ?, ?, ?)', date, seat, name, owner, Date.now());
    this.cleanup();
    return { day: this.day(date, owner) };
  }

  release(date, owner) {
    this.sql.exec('DELETE FROM bookings WHERE date = ? AND owner = ?', date, owner);
    return { day: this.day(date, owner) };
  }

  cleanup() {
    const old = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM bookings WHERE date < ?', old);
    this.sql.exec('DELETE FROM homework WHERE date < ?', old);
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

    if (url.pathname === '/api/days' && request.method === 'GET') {
      const dates = (url.searchParams.get('dates') || '').split(',').filter(d => DATE.test(d)).slice(0, 10);
      return json({ days: await board.days(dates, owner) });
    }
    if (url.pathname === '/api/hw' && request.method === 'GET') {
      const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
      if (!DATE.test(from) || !DATE.test(to)) return fail('date');
      return json({ hw: await board.hw(from, to) });
    }

    if (request.method !== 'POST') return fail('method', 405);
    let body;
    try { body = await request.json(); } catch { return fail('json'); }
    const date = String(body.date || '');

    if (url.pathname === '/api/hw') {
      const lesson = Number(body.lesson);
      const text = String(body.text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 600);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      if (!hwDate(date)) return fail('date');
      if (!Number.isInteger(lesson) || lesson < 1 || lesson > 12) return fail('lesson');
      if (name.length < 2) return fail('name');
      return json(await board.setHw(date, lesson, text, name, owner));
    }

    if (!bookable(date)) return fail('date');

    if (url.pathname === '/api/book') {
      const seat = String(body.seat || '');
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      if (!SEAT.test(seat)) return fail('seat');
      if (name.length < 2) return fail('name');
      const r = await board.book(date, seat, name, owner);
      return r.error ? fail(r.error, 409) : json(r);
    }
    if (url.pathname === '/api/release') return json(await board.release(date, owner));
    return fail('not_found', 404);
  },
};
