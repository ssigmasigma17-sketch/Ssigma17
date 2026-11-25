// Cloudflare Worker: броні парт, домашка, опитування й чат класу в Durable Object (SQLite).
// Якщо поруч є public/ (binding ASSETS), віддає і сам сайт; інакше лише API для сторінки на GitHub Pages.
//
//   GET  /api/sync?dates=…&from=…&to=…&chat=<останній id>&rev=<версія чату>
//        days: { [date]: { slots: { [урок]: { seats: { "2-4": { name } }, mine } } } }
//        Урок (slot) — номер уроку, для поділу на групи ще й група: "3", "4.1", "4.2".
//        → { days, hw, polls, chat: { rev, full, msgs } } — усе, що сторінка оновлює раз на кілька секунд
//   POST /api/book          { date, slots, seat, name }  бронює ту саму парту на кожен урок зі slots, де вона вільна;
//                                                        409 { code: 'taken' }, якщо зайнята на всіх; 400 { code: 'date' } — не напередодні
//   POST /api/release       { date, slots }              звільнити свою парту на цих уроках
//   POST /api/hw            { date, lesson, text, name } порожній text стирає запис
//   GET  /api/hw/history?date=…&lesson=…              попередні версії, новіші першими
//   POST /api/polls         { q, options, name }
//   POST /api/polls/vote    { id, option }               option = null знімає голос
//   POST /api/polls/delete  { id }                       автор або староста
//   POST /api/chat          { text, name }
//   POST /api/chat/delete   { id }                       автор або староста
//   POST /api/chat/react    { id, emoji }                поставити / зняти реакцію (👍 😂 ❤️ 🔥)
//   GET  /api/admin                                      { admin, booker } — чий це код: старости чи помічника
//   POST /api/admin/release { date, slot, seat }         староста знімає будь-яку бронь
//   POST /api/admin/book    { date, slots, seat, name }  староста або помічник бронює парту для когось іще (скільки завгодно парт,
//                                                        і на сьогодні теж)
//   GET  /api/admin/log                                  останні дії старости
//   POST /api/admin/tg-setup                             підключити Telegram-бота (вебхук і меню команд), див. bot.js
//   GET  /api/admin/tg-status                            стан бота: токен, вебхук, остання помилка Telegram
//   POST /tg                                             вебхук Telegram (перевіряється секретом)
//   POST /api/admin/hw-history-clear { date, lesson }
//
// Хто є хто — випадковий токен пристрою в заголовку x-token; у базі лежить лише його SHA-256.
// Код старости — заголовок x-admin; у коді лежить лише його SHA-256. Після 5 хибних кодів за 15 хв з однієї адреси
// сервер перестає перевіряти коди з неї. Усі дії старости пишуться в журнал.
// Імена назовні віддаються скорочено: «Нестор Гуцалік» → «Нестор Г.».
import { DurableObject } from 'cloudflare:workers';
import { handleTg, tgSetup, tgStatus, tgDaily } from './bot.js';

const ADMIN_HASH = '4623f62e26392e64161401c7820a182bf8550b0dcf6fb7cd1e57a31cb683aea2';
// Код помічника: уміє лише бронювати парти для інших (/api/admin/book), більше нічого.
const BOOKER_HASH = '15504a04db49c5fce0890e590911dfcc6f193214491d2df8036094647d6cc474';
// Парта — «ряд-парта». У різних кабінетах різна кількість рядів і парт, точний план знає сторінка,
// сервер лише не пускає неможливе: до 4 рядів, до 6 парт у ряду.
const SEAT = /^[1-4]-[1-6]$/;
const SLOT = /^(1[0-2]|[1-9])(\.[12])?$/;
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

// Сторінка лежить на GitHub Pages, тож браузери пускаємо лише звідти (і з локального сервера для розробки).
const ORIGINS = /^(https:\/\/ssigmasigma17-sketch\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const CORS = {
  'access-control-allow-origin': 'https://ssigmasigma17-sketch.github.io',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-token, x-admin',
  'access-control-max-age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
});
const fail = (code, status = 400) => json({ error: code, code }, status);
// список уроків: 1–16 рядків на зразок "3" або "4.2", без повторів; null — якщо щось не так
const slotList = v => {
  if (!Array.isArray(v) || !v.length || v.length > 16) return null;
  const list = [...new Set(v.map(String))];
  return list.every(x => SLOT.test(x)) ? list : null;
};
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
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_log (at INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS tg_chats (chat INTEGER PRIMARY KEY, title TEXT NOT NULL, added INTEGER NOT NULL)');
    // броні по уроках: на кожен урок своя парта
    this.sql.exec(`CREATE TABLE IF NOT EXISTS desk_bookings (
      date TEXT NOT NULL, slot TEXT NOT NULL, seat TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (date, slot, seat), UNIQUE (date, slot, owner))`);
    this.hits = new Map();
    this.ipOwners = new Map();
    try { this.migrate(); } catch (e) { console.error('migrate', e); } // збій міграції не має ламати сервер
  }

  // Одноразові зміни даних; кожна виконується один раз (позначка в meta).
  migrate() {
    const done = key => this.sql.exec('SELECT 1 FROM meta WHERE key = ?', key).toArray().length > 0;
    const mark = key => this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, Date.now());
    // 25.11.2026: групи 1 і 2 були переплутані в розкладі. Броні на англійську (обидві групи) скидаємо,
    // броні на інформатику переносимо в іншу групу — люди лишаються в тому ж кабінеті за тією ж партою.
    if (!done('groups-swap-2026-11')) {
      const today = kyivToday();
      // день тижня в SQLite: 1 — понеділок … 5 — пʼятниця; номери уроків англійської з розкладу
      const engWhere = `date >= ? AND (
          (strftime('%w', date) = '1' AND slot IN ('5.1', '5.2')) OR
          (strftime('%w', date) = '2' AND slot IN ('4.1', '4.2')) OR
          (strftime('%w', date) = '4' AND slot IN ('3.1', '3.2', '4.1', '4.2')) OR
          (strftime('%w', date) = '5' AND slot IN ('4.1', '4.2')))`;
      const eng = this.sql.exec(`SELECT COUNT(*) AS n FROM desk_bookings WHERE ${engWhere}`, today).one().n;
      this.sql.exec(`DELETE FROM desk_bookings WHERE ${engWhere}`, today);
      const inf = `date >= ? AND strftime('%w', date) IN ('1', '5') AND slot IN ('7.1', '7.2')`;
      const swapped = this.sql.exec(`SELECT COUNT(*) AS n FROM desk_bookings WHERE ${inf}`, today).one().n;
      this.sql.exec(`UPDATE desk_bookings SET slot = CASE slot WHEN '7.1' THEN '7.x' ELSE '7.y' END WHERE ${inf}`, today);
      this.sql.exec(`UPDATE desk_bookings SET slot = CASE slot WHEN '7.x' THEN '7.2' ELSE '7.1' END
        WHERE date >= ? AND slot IN ('7.x', '7.y')`, today);
      this.log('групи', `групи 1 і 2 поміняно місцями; скинуто бронь на англійську: ${eng}; перенесено на інформатику: ${swapped}`);
      mark('groups-swap-2026-11');
    }
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
    const slots = {};
    for (const r of this.sql.exec('SELECT slot, seat, name, owner FROM desk_bookings WHERE date = ?', date)) {
      const s = (slots[r.slot] ||= { seats: {}, mine: null });
      s.seats[r.seat] = { name: shortName(r.name) };
      if (r.owner === owner) s.mine = r.seat;
    }
    return { slots };
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
        // на кожен урок — одна парта на людину; якщо на якомусь уроці парта зайнята, його пропускаємо
        const booked = [], taken = [];
        for (const slot of a.slots) {
          const cur = this.sql.exec('SELECT owner FROM desk_bookings WHERE date = ? AND slot = ? AND seat = ?', a.date, slot, a.seat).toArray()[0];
          if (cur && cur.owner !== owner) { taken.push(slot); continue; }
          this.sql.exec('DELETE FROM desk_bookings WHERE date = ? AND slot = ? AND owner = ?', a.date, slot, owner);
          this.sql.exec('INSERT INTO desk_bookings (date, slot, seat, name, owner, created) VALUES (?, ?, ?, ?, ?, ?)',
            a.date, slot, a.seat, a.name, owner, Date.now());
          booked.push(slot);
        }
        if (!booked.length) return { error: 'taken' };
        this.cleanup();
        return { day: this.day(a.date, owner), booked, taken };
      }
      case 'release':
        for (const slot of a.slots) this.sql.exec('DELETE FROM desk_bookings WHERE date = ? AND slot = ? AND owner = ?', a.date, slot, owner);
        return { day: this.day(a.date, owner) };
      case 'adminRelease': {
        if (!who.admin) return { error: 'admin' };
        const cur = this.sql.exec('SELECT name FROM desk_bookings WHERE date = ? AND slot = ? AND seat = ?', a.date, a.slot, a.seat).toArray()[0];
        this.sql.exec('DELETE FROM desk_bookings WHERE date = ? AND slot = ? AND seat = ?', a.date, a.slot, a.seat);
        if (cur) this.log('зняв бронь', `${a.date}, урок ${a.slot}, парта ${a.seat} — ${cur.name}`);
        return { day: this.day(a.date, owner) };
      }
      case 'adminBook': {
        // бронь від імені старости чи помічника для когось іще: окремий «власник» на кожну бронь,
        // тож парт може бути скільки завгодно
        if (!who.admin && !who.booker) return { error: 'admin' };
        const proxy = `admin:${crypto.randomUUID()}`, booked = [], taken = [];
        for (const slot of a.slots) {
          if (this.sql.exec('SELECT 1 FROM desk_bookings WHERE date = ? AND slot = ? AND seat = ?', a.date, slot, a.seat).toArray().length) { taken.push(slot); continue; }
          this.sql.exec('INSERT INTO desk_bookings (date, slot, seat, name, owner, created) VALUES (?, ?, ?, ?, ?, ?)',
            a.date, slot, a.seat, a.name, proxy, Date.now());
          booked.push(slot);
        }
        if (!booked.length) return { error: 'taken' };
        this.log(who.admin ? 'забронював' : 'помічник забронював', `${a.date}, уроки ${booked.join(', ')}, парта ${a.seat} — ${a.name}`);
        return { day: this.day(a.date, owner), booked, taken };
      }
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
        this.log('очистив історію домашки', `${a.date}, урок ${a.lesson}`);
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
        if (p.owner !== owner) this.log('видалив опитування', `#${a.id}`);
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
        if (m.owner !== owner) this.log('видалив повідомлення', `#${a.id}`);
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

  // ---------- Telegram: чати, підписані на нагадування ----------
  async tgSubscribe(chat, title, max) {
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM tg_chats').one().n;
    const has = this.sql.exec('SELECT 1 FROM tg_chats WHERE chat = ?', chat).toArray().length;
    if (!has && n >= max) return { error: 'limit' };
    this.sql.exec('INSERT INTO tg_chats (chat, title, added) VALUES (?, ?, ?) ON CONFLICT (chat) DO UPDATE SET title = excluded.title',
      chat, String(title).slice(0, 64), Date.now());
    await this.tgAlarm();
    return { ok: true };
  }
  // Будильник замість cron: щогодини на початку години, а бот надсилає лише о 7:00 і 19:00 за Києвом.
  // TG_ALARM_MS (необовʼязково) — інший інтервал для перевірки.
  async tgAlarm() {
    if (await this.ctx.storage.getAlarm()) return;
    const every = +this.env.TG_ALARM_MS || 3600e3;
    await this.ctx.storage.setAlarm(Math.ceil((Date.now() + 1000) / every) * every + 5000);
  }
  async alarm() {
    try {
      if (this.tgChats().length) await tgDaily(this.env, this);
    } finally {
      if (this.tgChats().length) await this.tgAlarm();
    }
  }
  tgUnsubscribe(chat) {
    this.sql.exec('DELETE FROM tg_chats WHERE chat = ?', chat);
  }
  tgChats() {
    return this.sql.exec('SELECT chat FROM tg_chats').toArray().map(r => r.chat);
  }
  // true лише для першого виклику з цим ключем: одне нагадування на годину, навіть якщо будильник спрацює двічі
  // одноразові дії (напр. оновити меню бота після деплою): прочитати прапорець або позначити як зроблене
  async tgFlag(key, done = false) {
    if (done) { await this.ctx.storage.put(`flag:${key}`, 1); return true; }
    return !!(await this.ctx.storage.get(`flag:${key}`));
  }

  async tgOnce(key) {
    if ((await this.ctx.storage.get('tgLast')) === key) return false;
    await this.ctx.storage.put('tgLast', key);
    return true;
  }

  log(action, detail) {
    this.sql.exec('INSERT INTO admin_log (at, action, detail) VALUES (?, ?, ?)', Date.now(), action, detail);
  }
  adminLog() {
    this.sql.exec('DELETE FROM admin_log WHERE at < ?', Date.now() - 60 * DAY);
    return this.sql.exec('SELECT at, action, detail FROM admin_log ORDER BY at DESC LIMIT 40').toArray();
  }

  cleanup() {
    const old = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM desk_bookings WHERE date < ?', old);
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

// хибні коди старости: після 5 спроб за 15 хв з адреси коди з неї більше не перевіряються
const adminFails = new Map();
function adminBlocked(ip) {
  const e = adminFails.get(ip);
  return !!e && Date.now() - e.t < 15 * 60e3 && e.n >= 5;
}
function adminFailed(ip) {
  const now = Date.now();
  let e = adminFails.get(ip);
  if (!e || now - e.t > 15 * 60e3) adminFails.set(ip, (e = { t: now, n: 0 }));
  if (adminFails.size > 5000) adminFails.clear();
  e.n++;
}

const boardOf = env => env.BOARD.get(env.BOARD.idFromName('8b'));

export default {
  async fetch(request, env) {
    const res = await handle(request, env);
    // браузерам дозволяємо читати відповіді лише на сторінці класу
    const origin = request.headers.get('origin') || '';
    if (ORIGINS.test(origin)) {
      res.headers.set('access-control-allow-origin', origin);
      res.headers.set('vary', 'Origin');
    }
    return res;
  },
};

async function handle(request, env) {
  {
    const url = new URL(request.url);
    if (url.pathname === '/tg' && request.method === 'POST') return handleTg(request, env, boardOf(env));
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : fail('not_found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (flood(ip)) return fail('slow', 429);
    const token = request.headers.get('x-token') || '';
    if (!/^[0-9a-f]{32}$/.test(token)) return fail('token', 401);
    const adminKey = request.headers.get('x-admin') || '';
    let admin = false, booker = false;
    if (adminKey) {
      if (adminBlocked(ip)) return fail('blocked', 429);
      const hash = await sha256(adminKey);
      admin = hash === ADMIN_HASH;
      booker = hash === BOOKER_HASH;
      if (!admin && !booker) adminFailed(ip);
    }
    const who = { owner: await sha256(token), ip, admin, booker };
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
      if (path === '/api/admin') return json({ admin: who.admin, booker: who.booker });
      if (path === '/api/admin/log') return who.admin ? json({ log: await board.adminLog() }) : fail('admin', 403);
      if (path === '/api/admin/tg-status') return who.admin ? json(await tgStatus(env, url.origin)) : fail('admin', 403);
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
        const seat = String(body.seat || ''), slots = slotList(body.slots);
        if (!bookable(date)) return fail('date');
        if (!SEAT.test(seat) || !slots) return fail('seat');
        if (name.length < 2) return fail('name');
        return act('book', { date, slots, seat, name });
      }
      case '/api/release': {
        const slots = slotList(body.slots);
        if (!releasable(date)) return fail('date');
        if (!slots) return fail('seat');
        return act('release', { date, slots });
      }
      case '/api/admin/tg-setup': {
        if (!who.admin) return fail('admin', 403);
        const r = await tgSetup(env, url.origin);
        return r.error ? json({ error: r.error, code: r.error, detail: r.detail || null }, 400) : json(r);
      }
      case '/api/admin/book': {
        const seat = String(body.seat || ''), slots = slotList(body.slots);
        // староста може бронювати й на сьогодні, але не далі ніж на два тижні
        if (!releasable(date) || ms(date) > ms(kyivToday()) + 14 * DAY) return fail('date');
        if (!SEAT.test(seat) || !slots) return fail('seat');
        if (name.length < 2) return fail('name');
        return act('adminBook', { date, slots, seat, name });
      }
      case '/api/admin/release': {
        const seat = String(body.seat || ''), slot = String(body.slot || '');
        if (!DATE.test(date) || !SEAT.test(seat) || !SLOT.test(slot)) return fail('seat');
        return act('adminRelease', { date, slot, seat });
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
  }
}
