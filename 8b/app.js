(() => {
  const C = window.CLASS;
  const $ = id => document.getElementById(id);
  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  // ---------- Telegram Mini App ----------
  // Усередині Telegram сайт відкривається як міні-застосунок. Telegram передає параметри в #хеші;
  // спілкуємося з ним напряму подіями (core.telegram.org/api/web-events), без сторонніх скриптів.
  const tgParams = new URLSearchParams(location.hash.slice(1));
  const tgLaunch = tgParams.has('tgWebAppVersion') || tgParams.has('tgWebAppData');
  const inTg = (() => {
    try {
      if (tgLaunch) sessionStorage.setItem('tg', tgParams.get('tgWebAppThemeParams') || '{}');
      return sessionStorage.getItem('tg') != null || !!window.TelegramWebviewProxy;
    } catch { return tgLaunch || !!window.TelegramWebviewProxy; }
  })();
  const tgTheme = (() => {
    try { return JSON.parse(tgParams.get('tgWebAppThemeParams') || sessionStorage.getItem('tg') || '{}'); } catch { return {}; }
  })();
  function tgPost(eventType, eventData = {}) {
    if (!inTg) return;
    try {
      if (window.TelegramWebviewProxy) window.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData));
      else if (window.external && 'notify' in window.external) window.external.notify(JSON.stringify({ eventType, eventData }));
      else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType, eventData }), '*');
    } catch { /* не в Telegram або стара версія — просто ігноруємо */ }
  }
  // темна чи світла тема в Telegram — за яскравістю його фону
  const tgDark = (() => {
    const m = /^#?([0-9a-f]{6})$/i.exec(tgTheme.bg_color || '');
    if (!m) return null;
    const n = parseInt(m[1], 16), lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum < 128;
  })();
  const toHex = rgb => {
    const m = rgb.match(/\d+/g);
    return m && m.length >= 3 ? '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join('') : null;
  };
  function tgColors() {
    if (!inTg) return;
    const bg = toHex(getComputedStyle(document.body).backgroundColor);
    if (!bg) return;
    tgPost('web_app_set_header_color', { color: bg });
    tgPost('web_app_set_background_color', { color: bg });
    tgPost('web_app_set_bottom_bar_color', { color: bg });
  }
  const haptic = (kind = 'success') => tgPost('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: kind });
  if (inTg) document.documentElement.classList.add('in-tg');

  // ---------- сховище браузера ----------
  const store = {
    get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  let token = store.get('token');
  if (!token) {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    token = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
    store.set('token', token);
  }

  // ---------- час (завжди київський) ----------
  const toMin = s => { const [hh, mm] = s.split(':').map(Number); return hh * 60 + mm; };
  const BELLS = C.bells.map(([a, b]) => [toMin(a), toMin(b)]);
  const fmt = m => `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
  const DOW = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
  const DOW_S = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const DOW_ON = ['у неділю', 'у понеділок', 'у вівторок', 'у середу', 'у четвер', 'у пʼятницю', 'у суботу'];
  const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  const KYIV = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });

  function kyivNow() {
    const p = Object.fromEntries(KYIV.formatToParts(new Date()).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    return { date, dow: dowOf(date), min: +p.hour * 60 + +p.minute + +p.second / 60, hms: `${p.hour}:${p.minute}:${p.second}` };
  }
  const utc = date => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const dowOf = date => utc(date).getUTCDay();
  const addDays = (date, n) => { const t = utc(date); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const dayNum = date => +date.slice(8, 10);
  const longDate = date => `${dayNum(date)} ${MONTHS[+date.slice(5, 7) - 1]}`;

  const lessonsOf = dow => (dow >= 1 && dow <= 5 ? C.week[dow - 1] : null);
  // тижні чергуються: 0 — 1-й тиждень, 1 — 2-й (від понеділка C.altStart)
  const weekNo = date => ((Math.floor((utc(date) - utc(C.altStart)) / 864e5 / 7) % 2) + 2) % 2;
  const resolve = (l, date) => (l && l.alt ? l.alt[weekNo(date)] : l);
  // уроки конкретного дня, з урахуванням предметів, що чергуються
  const lessonsOn = date => { const L = lessonsOf(dowOf(date)); return L && L.map(l => resolve(l, date)); };
  const span = L => {
    const idx = L.map((l, i) => (l ? i : -1)).filter(i => i >= 0);
    return { first: idx[0], last: idx[idx.length - 1], count: idx.length };
  };
  const subjOf = l => l.s || l.g.map(g => g.s).join(' / ');
  const roomOf = l => l.r || [...new Set(l.g.map(g => g.r))].join(' / ');
  const whoOf = l => l.t || l.g.map(g => g.t.split(' ')[0]).join(' / ');
  const dayOver = now => { const L = lessonsOf(now.dow); return !L || now.min >= BELLS[span(L).last][1]; };

  function nextSchoolDay(date) {
    let d = addDays(date, 1);
    while (!lessonsOf(dowOf(d))) d = addDays(d, 1);
    return d;
  }
  function countdown(mins) {
    const s = Math.max(0, Math.round(mins * 60));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = n => String(n).padStart(2, '0');
    return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
  }

  // ---------- що зараз ----------
  function status(now) {
    const L = lessonsOn(now.date);
    if (L) {
      const { first, last, count } = span(L);
      if (now.min < BELLS[first][0]) {
        const l = L[first];
        return {
          key: 'before', label: 'До першого уроку', title: subjOf(l), count: countdown(BELLS[first][0] - now.min),
          sub: `Початок о <b>${fmt(BELLS[first][0])}</b> · каб. ${roomOf(l)} · сьогодні ${count} ${plural(count, 'урок', 'уроки', 'уроків')}`,
        };
      }
      for (let i = first; i <= last; i++) {
        const [a, b] = BELLS[i];
        if (now.min >= a && now.min < b && L[i]) {
          const next = L.slice(i + 1).find(Boolean);
          return {
            key: `l${i}`, lesson: i, label: `${i + 1} урок · ${fmt(a)}–${fmt(b)}`, title: subjOf(L[i]),
            count: countdown(b - now.min), ruler: [b - a, now.min - a],
            sub: `${whoOf(L[i])} · каб. ${roomOf(L[i])}${next ? ` · далі <b>${subjOf(next)}</b>` : ' · останній урок'}`,
          };
        }
        const nextI = L.findIndex((x, j) => j > i && x);
        if (nextI > 0 && now.min >= b && now.min < BELLS[nextI][0]) {
          const len = BELLS[nextI][0] - b, note = C.breakNotes[i + 1];
          return {
            key: `b${i}`, brk: i, label: `Перерва ${len} хв${note ? ' · ' + note : ''}`, title: `Далі: ${subjOf(L[nextI])}`,
            count: countdown(BELLS[nextI][0] - now.min), ruler: [len, now.min - b],
            sub: `${nextI + 1} урок о <b>${fmt(BELLS[nextI][0])}</b> · каб. ${roomOf(L[nextI])}`,
          };
        }
      }
    }
    const nd = nextSchoolDay(now.date), NL = lessonsOn(nd), { first } = span(NL);
    const when = nd === addDays(now.date, 1) ? 'завтра' : DOW_ON[dowOf(nd)];
    const left = (utc(nd) - utc(now.date)) / 864e5 * 1440 + BELLS[first][0] - now.min;
    return {
      key: 'off', label: L ? 'Уроки закінчились' : 'Вихідний',
      title: `${cap(when)} перший — ${subjOf(NL[first])}`,
      // менше доби — зворотний відлік, інакше просто час
      count: left < 1440 ? countdown(left) : fmt(BELLS[first][0]),
      sub: '',
    };
  }
  const cap = s => s[0].toUpperCase() + s.slice(1);
  function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }

  // ---------- смуга дня ----------
  const SHORT = {
    'Англійська мова': 'Англ', 'Українська мова': 'Укр', 'Українська література': 'Укр л', 'Зарубіжна література': 'Зар л',
    'Фізкультура': 'Фізра', 'Інформатика': 'Інф', 'Геометрія': 'Геом', 'Алгебра': 'Алг', 'Історія': 'Іст', 'Біологія': 'Біо',
    'Географія': 'Геогр', 'Хімія': 'Хім', 'Фізика': 'Фіз', 'Технології': 'Техн', 'Світ професій': 'Проф', 'ІК «Мистецтво»': 'Мист',
    'ІК «Здоров’я, безпека та добробут»': 'ЗБД', 'Підприємництво і фінансова грамотність': 'Фін', 'Громадянська освіта': 'Гром',
  };
  const shortOf = l => (l.s ? SHORT[l.s] || l.s.slice(0, 4) : 'A / B');
  const dur = m => {
    m = Math.max(0, Math.ceil(m));
    const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
    return d ? `${d} дн ${hh} год` : hh ? `${hh} год ${mm} хв` : `${mm} хв`;
  };
  // день, який показує смуга: сьогодні, поки йдуть уроки, інакше наступний навчальний
  const stripDay = now => (dayOver(now) ? nextSchoolDay(now.date) : now.date);
  let strip = null;

  function renderStrip(now) {
    const date = stripDay(now), L = lessonsOn(date), { first, last, count } = span(L);
    const t0 = BELLS[first][0], t1 = BELLS[last][1], pct = m => `${((m - t0) / (t1 - t0)) * 100}%`;
    const when = date === now.date ? 'Сьогодні' : date === addDays(now.date, 1) ? 'Завтра' : cap(DOW[dowOf(date)]);
    $('strip-title').textContent = `${when} · ${count} ${plural(count, 'урок', 'уроки', 'уроків')}`;
    $('strip-from').textContent = fmt(t0);
    $('strip-to').textContent = fmt(t1);
    const track = $('strip-track');
    track.textContent = '';
    const segs = [];
    L.forEach((l, i) => {
      if (!l) return;
      const [a, b] = BELLS[i], seg = h('span', 'seg');
      seg.style.left = pct(a);
      seg.style.width = pct(t0 + (b - a));
      seg.append(h('b', '', i + 1), h('i', '', shortOf(l)));
      seg.title = `${i + 1}. ${subjOf(l)}, ${fmt(a)}–${fmt(b)}`;
      if (hw[`${date}|${i + 1}`]) seg.classList.add('has-hw');
      track.append(seg);
      segs.push({ seg, a, b });
    });
    const mark = h('span', 'mark');
    track.append(mark);
    strip = { date, t0, t1, segs, mark };
  }

  function updateStrip(now) {
    if (!strip || strip.date !== stripDay(now)) renderStrip(now);
    const { date, t0, t1, segs, mark } = strip, today = date === now.date;
    for (const { seg, a, b } of segs) {
      seg.classList.toggle('past', today && now.min >= b);
      seg.classList.toggle('cur', today && now.min >= a && now.min < b);
    }
    mark.hidden = !today || now.min < t0 || now.min > t1;
    mark.style.left = `${((now.min - t0) / (t1 - t0)) * 100}%`;
    $('strip-left').textContent = !today ? `початок о ${fmt(t0)}` : now.min < t0 ? `початок через ${dur(t0 - now.min)}` : `до кінця ${dur(t1 - now.min)}`;
    $('strip-weekend').textContent = weekendText(now);
  }

  function weekendText(now) {
    if (now.dow < 1 || now.dow > 5) return 'вихідні';
    const fridayEnd = BELLS[span(C.week[4]).last][1];
    const left = (5 - now.dow) * 1440 + fridayEnd - now.min;
    return left > 0 ? `до вихідних ${dur(left)}` : 'вихідні';
  }

  // ---------- шапка ----------
  let lastKey = '';
  function tick() {
    const now = kyivNow();
    $('today-dow').textContent = DOW[now.dow];
    $('today-date').textContent = longDate(now.date);
    $('clock').textContent = now.hms;
    const st = status(now);
    $('now-label').textContent = st.label;
    $('now-title').textContent = st.title;
    $('now-count').textContent = st.count;
    $('now-sub').innerHTML = st.sub;
    $('ruler').hidden = !st.ruler;
    if (st.ruler) {
      $('ruler').querySelector('.ruler-ticks').style.setProperty('--mins', st.ruler[0]);
      $('ruler-fill').style.width = `${Math.min(100, (st.ruler[1] / st.ruler[0]) * 100)}%`;
    }
    document.title = st.key === 'off' ? '8-Б' : `${st.count} · 8-Б`;
    updateStrip(now);
    const key = `${now.date}|${st.key}`;
    if (key !== lastKey) {
      const dayChanged = lastKey.split('|')[0] !== now.date;
      lastKey = key;
      renderWeek(now, st);
      renderBells(now, st);
      if (dayChanged || st.key === 'off') setBookDates(now);
    }
  }

  // ---------- броні: на кожен урок своя парта ----------
  const seatName = id => { const [r, d] = id.split('-'); return { r, d, text: `ряд ${r}, парта ${d}` }; };
  // план кабінету — скільки парт у кожному ряду
  const layoutFor = subj => C.layouts[subj] || C.layouts.default;
  const seatsOf = lay => lay.flatMap((n, i) => Array.from({ length: n }, (_, d) => `${i + 1}-${d + 1}`));
  // уроки дня, на які бронюють парти; при поділі на групи в кожної групи свій кабінет і свій план
  function slotsOf(date) {
    const L = lessonsOn(date), out = [];
    if (!L) return out;
    L.forEach((l, n) => {
      if (!l || C.noDesks.includes(l.s)) return;
      if (l.g) l.g.forEach((g, gi) => {
        const subj = g.s || l.s;
        out.push({ id: `${n + 1}.${gi + 1}`, n, subj, room: g.r, group: gi + 1, layout: layoutFor(subj) });
      });
      else out.push({ id: `${n + 1}`, n, subj: l.s, room: l.r, group: 0, layout: layoutFor(l.s) });
    });
    return out;
  }
  const slotOf = (date, id) => slotsOf(date).find(sl => sl.id === id);
  // лишаємо тільки парти, які є в плані цього уроку
  const cleanDay = (day, date) => {
    const slots = {};
    for (const sl of slotsOf(date)) {
      const x = day.slots?.[sl.id], ids = seatsOf(sl.layout);
      if (!x) continue;
      const seats = {};
      for (const id of ids) if (x.seats[id]) seats[id] = x.seats[id];
      slots[sl.id] = { seats, mine: ids.includes(x.mine) ? x.mine : null };
    }
    return { slots };
  };
  const slotData = (date, id) => data[date]?.slots?.[id] || { seats: {}, mine: null };
  const myCount = date => slotsOf(date).filter(sl => slotData(date, sl.id).mine).length;

  // Сервер — src/worker.js. Якщо його немає — демо в localStorage.
  let adminKey = store.get('admin');
  const server = {
    async req(path, body) {
      const headers = { 'content-type': 'application/json', 'x-token': token };
      if (adminKey) headers['x-admin'] = adminKey;
      // не чекаємо відповіді вічно: за 25 с запит скасовується
      let r;
      try {
        r = await fetch((C.api || '').replace(/\/$/, '') + path, {
          method: body ? 'POST' : 'GET',
          headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
          signal: AbortSignal.timeout(25000),
        });
      } catch (e) {
        if (e.name === 'TimeoutError') throw Object.assign(new Error('timeout'), { code: 'timeout' });
        throw e;
      }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw Object.assign(new Error('no api'), { noApi: true, status: r.status });
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data.error || 'error'), { code: data.code, detail: data.detail });
      return data;
    },
    sync: q => server.req(`/api/sync?dates=${q.dates.join(',')}&from=${q.from}&to=${q.to}&chat=${q.chat}&rev=${q.rev}`),
    book: (date, slots, seat, name) => server.req('/api/book', { date, slots, seat, name }),
    release: (date, slots) => server.req('/api/release', { date, slots }),
    setHw: (date, lesson, text, name) => server.req('/api/hw', { date, lesson, text, name }),
    hwHistory: (date, lesson) => server.req(`/api/hw/history?date=${date}&lesson=${lesson}`),
    createPoll: (q, options, name) => server.req('/api/polls', { q, options, name }),
    vote: (id, option) => server.req('/api/polls/vote', { id, option }),
    deletePoll: id => server.req('/api/polls/delete', { id }),
    sendChat: (text, name) => server.req('/api/chat', { text, name }),
    deleteChat: id => server.req('/api/chat/delete', { id }),
    react: (id, emoji) => server.req('/api/chat/react', { id, emoji }),
    adminCheck: () => server.req('/api/admin'),
    adminRelease: (date, slot, seat) => server.req('/api/admin/release', { date, slot, seat }),
    adminBook: (date, slots, seat, name) => server.req('/api/admin/book', { date, slots, seat, name }),
    adminLog: () => server.req('/api/admin/log'),
    tgSetup: () => server.req('/api/admin/tg-setup', {}),
    tgStatus: () => server.req('/api/admin/tg-status'),
    hwHistoryClear: (date, lesson) => server.req('/api/admin/hw-history-clear', { date, lesson }),
  };

  const demo = {
    all() { return store.get('demo-bookings-v4', {}); },
    day(all, date) { return (all[date] ||= { slots: {} }); },
    async days(dates) {
      const all = demo.all(), days = {};
      for (const d of dates) days[d] = demo.day(all, d);
      return { days };
    },
    async book(date, slots, seat, name) {
      const all = demo.all(), day = demo.day(all, date), booked = [], taken = [];
      for (const id of slots) {
        const x = (day.slots[id] ||= { seats: {}, mine: null });
        if (x.seats[seat] && x.mine !== seat) { taken.push(id); continue; }
        if (x.mine) delete x.seats[x.mine];
        x.seats[seat] = { name };
        x.mine = seat;
        booked.push(id);
      }
      if (!booked.length) throw Object.assign(new Error('taken'), { code: 'taken' });
      store.set('demo-bookings-v4', all);
      return { day, booked, taken };
    },
    async release(date, slots) {
      const all = demo.all(), day = demo.day(all, date);
      for (const id of slots) {
        const x = day.slots[id];
        if (x?.mine) { delete x.seats[x.mine]; x.mine = null; }
      }
      store.set('demo-bookings-v4', all);
      return { day };
    },
    async hw(from, to) {
      const all = store.get('demo-hw', {}), hw = {};
      for (const [k, v] of Object.entries(all)) if (k.slice(0, 10) >= from && k.slice(0, 10) <= to) hw[k] = v;
      return { hw };
    },
    async setHw(date, lesson, text, name) {
      const all = store.get('demo-hw', {}), key = `${date}|${lesson}`;
      if (all[key] && all[key].text !== text) {
        const hist = store.get('demo-hw-hist', {});
        (hist[key] ||= []).unshift(all[key]);
        store.set('demo-hw-hist', hist);
      }
      if (text) all[key] = { text, by: name, at: Date.now() };
      else delete all[key];
      store.set('demo-hw', all);
      return { hw: all[key] ? { [key]: all[key] } : {} };
    },
    async hwHistory(date, lesson) {
      return { history: store.get('demo-hw-hist', {})[`${date}|${lesson}`] || [] };
    },
    pollView() {
      return { polls: store.get('demo-polls', []).map(p => {
        const counts = p.options.map((o, i) => (p.mine === i ? 1 : 0));
        return { ...p, counts, total: counts.reduce((a, b) => a + b, 0), own: true };
      }) };
    },
    async sync(q) {
      const { days } = await demo.days(q.dates), { hw } = await demo.hw(q.from, q.to);
      const msgs = store.get('demo-chat', []).map(m => ({ ...m, own: true }));
      return { days, hw, polls: demo.pollView().polls, chat: { rev: 0, full: true, msgs } };
    },
    async sendChat(text, name) {
      const all = store.get('demo-chat', []);
      all.push({ id: (all.at(-1)?.id || 0) + 1, text, by: name, at: Date.now() });
      store.set('demo-chat', all.slice(-100));
      return { ok: true };
    },
    async deleteChat(id) {
      store.set('demo-chat', store.get('demo-chat', []).filter(m => m.id !== id));
      return { ok: true };
    },
    async adminCheck() { return { admin: false }; },
    async react() { return { ok: true }; },
    async createPoll(q, options, name) {
      const all = store.get('demo-polls', []);
      all.unshift({ id: Date.now(), q, options, by: name, at: Date.now(), mine: null });
      store.set('demo-polls', all);
      return demo.pollView();
    },
    async vote(id, option) {
      const all = store.get('demo-polls', []);
      for (const p of all) if (p.id === id) p.mine = option;
      store.set('demo-polls', all);
      return demo.pollView();
    },
    async deletePoll(id) {
      store.set('demo-polls', store.get('demo-polls', []).filter(p => p.id !== id));
      return demo.pollView();
    },
  };

  let api = server;
  let bookDates = [];
  let selDate = null, selSlot = null;
  let data = {};          // date -> { slots: { урок: { seats: { id: { name } }, mine } } }
  let hw = {};            // "date|урок" -> { text, by, at }
  let polls = [];
  let lastSync = 0;
  // роль за кодом: староста може все, помічник — лише бронювати парти для інших
  let isAdmin = !!adminKey && store.get('role', 'admin') === 'admin';
  let isBooker = !!adminKey && store.get('role', 'admin') === 'booker';
  const canBookOthers = () => isAdmin || isBooker;
  const SLOW = 'Забагато дій підряд. Зачекай хвилину й спробуй знову.';

  // Бронювати можна лише напередодні: від попереднього навчального дня до початку самого дня
  // (на понеділок — з пʼятниці). Те саме перевіряє сервер.
  function bookable(date, today = kyivNow().date) {
    if (date <= today || !lessonsOf(dowOf(date))) return false;
    let prev = addDays(date, -1);
    while (!lessonsOf(dowOf(prev))) prev = addDays(prev, -1);
    return today >= prev;
  }
  let hwDates = [];

  function setBookDates(now) {
    // парти: сьогодні (подивитися, хто де сидить) і наступний навчальний день (його можна бронювати)
    const list = lessonsOf(now.dow) ? [now.date] : [];
    list.push(nextSchoolDay(now.date));
    const hwList = [];
    let d = dayOver(now) ? nextSchoolDay(now.date) : now.date;
    while (hwList.length < C.hwDays) { hwList.push(d); d = nextSchoolDay(d); }
    if (list.join() === bookDates.join() && hwList.join() === hwDates.join()) return;
    bookDates = list;
    hwDates = hwList;
    if (!bookDates.includes(selDate)) pickDate(dayOver(now) ? bookDates[bookDates.length - 1] : bookDates[0]);
    renderDays();
    renderHwPanel();
    refresh();
  }

  async function refresh() {
    if (!bookDates.length) return;
    try {
      const week = weekDates(kyivNow());
      const r = await api.sync({ dates: bookDates, from: week[0], to: addDays(week[0], 20), chat: chatLast, rev: chatRev });
      data = Object.fromEntries(Object.entries(r.days).map(([d, day]) => [d, cleanDay(day, d)]));
      hw = r.hw;
      polls = r.polls;
      mergeChat(r.chat);
      if (!lastSync && C.api) $('demo').hidden = true;
      lastSync = Date.now();
    } catch (e) {
      // сервер не вказано і на цьому ж сайті його немає (GitHub Pages, локальний файл) — демо
      if (api === server && !C.api && !lastSync && (e.noApi || e instanceof TypeError)) {
        api = demo;
        $('demo').hidden = false;
        return refresh();
      }
      if (C.api && !lastSync) {
        $('demo').textContent = 'Не вдається зʼєднатися із сервером броней. Перевір інтернет або спробуй пізніше.';
        $('demo').hidden = false;
        renderRoom();
        renderHwPanel();
      }
      $('sync').textContent = 'немає звʼязку';
      $('sync').classList.add('off');
      return;
    }
    renderDays();
    renderRoom();
    renderHwAll();
    renderPolls();
    renderDigest();
  }

  // ---------- домашка ----------
  const hwKey = (date, n) => `${date}|${n + 1}`;
  // «зроблено» — особисті позначки, лише на цьому пристрої
  let done = new Set(store.get('done', []));
  const isDone = key => done.has(key);
  function toggleDone(key) {
    if (done.has(key)) done.delete(key);
    else done.add(key);
    store.set('done', [...done].slice(-300));
    buzz(8);
    renderHwAll();
  }
  const hwCount = date => {
    const L = lessonsOf(dowOf(date));
    return L ? L.filter((l, n) => l && hw[hwKey(date, n)]).length : 0;
  };
  const doneCount = date => {
    const L = lessonsOf(dowOf(date));
    return L ? L.filter((l, n) => l && hw[hwKey(date, n)] && done.has(hwKey(date, n))).length : 0;
  };
  const ago = at => {
    const t = new Date(at), today = kyivNow().date;
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(t);
    const time = t.toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    return d === today ? `сьогодні о ${time}` : d === addDays(today, -1) ? `вчора о ${time}` : `${longDate(d)} о ${time}`;
  };
  let hwSel = null;

  function renderHwAll() {
    renderHwPanel();
    renderDigest();
    const now = kyivNow();
    renderWeek(now, status(now));
    strip = null;
    updateStrip(now);
  }

  function renderHwPanel() {
    if (!hwDates.length) return;
    if (!hwDates.includes(hwSel)) hwSel = hwDates[0];
    const chips = $('hw-days'), today = kyivNow().date;
    chips.textContent = '';
    for (const d of hwDates) {
      const b = h('button', 'day'), n = hwCount(d), L = lessonsOn(d);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(d === hwSel));
      b.setAttribute('aria-label', `${DOW[dowOf(d)]}, ${longDate(d)}: записано ${n}`);
      const bar = h('span', 'd-bar'), fill = h('i');
      fill.style.width = `${(n / span(L).count) * 100}%`;
      bar.append(fill);
      b.append(h('span', 'd-dow', DOW_S[dowOf(d)]), h('span', 'd-num', dayNum(d)), bar,
        h('span', 'd-today', d === today ? 'сьогодні' : n ? `${n} д/з` : ''));
      b.onclick = () => { hwSel = d; renderHwPanel(); };
      chips.append(b);
    }
    const L = lessonsOn(hwSel), n = hwCount(hwSel), total = span(L).count, dn = doneCount(hwSel);
    $('hw-day').textContent = `${cap(DOW[dowOf(hwSel)])}, ${longDate(hwSel)}`;
    $('hw-tally').innerHTML = n && dn ? `<b>${dn}/${n}</b>зроблено` : `<b>${n}</b>записано з ${total}`;
    const list = $('hw-list');
    list.textContent = '';
    L.forEach((l, i) => {
      if (!l) return;
      const item = hw[hwKey(hwSel, i)];
      const li = h('li'), btn = h('button', 'hw-item');
      btn.type = 'button';
      const body = h('span', 'body');
      body.append(h('span', 'subj', subjOf(l)));
      if (item) body.append(h('span', 'hw-text', item.text), h('span', 'hw-by', `${item.by}, ${ago(item.at)}`));
      else body.append(h('span', 'hw-add', 'записати'));
      btn.append(h('span', 'n', i + 1), body);
      btn.onclick = () => openHw(hwSel, i);
      li.className = 'hw-li';
      li.append(btn);
      if (item) {
        const key = hwKey(hwSel, i), on = isDone(key);
        li.classList.toggle('done', on);
        const chk = h('button', `hw-check${on ? ' on' : ''}`);
        chk.type = 'button';
        chk.setAttribute('role', 'checkbox');
        chk.setAttribute('aria-checked', String(on));
        chk.setAttribute('aria-label', `${subjOf(l)}: зроблено`);
        chk.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
        chk.onclick = () => toggleDone(key);
        li.append(chk);
      }
      list.append(li);
    });
  }

  let hwOpen = null;
  function openHw(date, n) {
    const L = lessonsOn(date), l = L && L[n];
    if (!l) return;
    hwOpen = { date, n };
    const item = hw[hwKey(date, n)], name = store.get('name', '');
    $('hw-eyebrow').textContent = `${n + 1} урок · ${DOW[dowOf(date)]}, ${longDate(date)}`;
    $('hw-title').textContent = subjOf(l);
    $('hw-meta').textContent = item ? `Записав(ла) ${item.by}, ${ago(item.at)}. Можна виправити.` : 'Поки нічого не записано.';
    $('hw-text').value = item ? item.text : '';
    $('hw-name').value = name;
    $('hw-name-field').hidden = !!name;
    $('hw-clear').hidden = !item;
    $('hw-error').textContent = '';
    loadHwHistory(date, n);
    $('scrim').hidden = false;
    $('hw-sheet').hidden = false;
    setTimeout(() => $('hw-text').focus(), 250);
  }

  // попередні версії запису: якщо хтось зіпсував домашку, її можна повернути
  async function loadHwHistory(date, n) {
    const box = $('hw-hist-box'), list = $('hw-hist'), btn = $('hw-hist-btn');
    box.hidden = true;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    let history = [];
    try { ({ history } = await api.hwHistory(date, n + 1)); } catch { return; }
    if (!hwOpen || hwOpen.date !== date || hwOpen.n !== n || !history.length) return;
    $('hw-hist-clear').hidden = !isAdmin;
    btn.textContent = `Попередні версії · ${history.length}`;
    list.textContent = '';
    for (const v of history) {
      const li = h('li', 'hist-item');
      const body = h('div', 'hist-body');
      body.append(h('div', 'hw-text', v.text), h('div', 'hw-by', `${v.by}, ${ago(v.at)}`));
      const back = h('button', 'link-btn hist-back', 'Повернути');
      back.type = 'button';
      back.onclick = () => saveHw(v.text);
      li.append(body, back);
      list.append(li);
    }
    box.hidden = false;
  }
  $('hw-hist-clear').addEventListener('click', async () => {
    const { date, n } = hwOpen;
    try {
      await api.hwHistoryClear(date, n + 1);
      $('hw-hist-box').hidden = true;
      toast('Історію очищено');
    } catch {
      toast('Не вдалося очистити історію.');
    }
  });
  $('hw-hist-btn').addEventListener('click', () => {
    const open = $('hw-hist').hidden;
    $('hw-hist').hidden = !open;
    $('hw-hist-btn').setAttribute('aria-expanded', String(open));
  });

  async function saveHw(text) {
    const { date, n } = hwOpen;
    const name = $('hw-name').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) {
      $('hw-name-field').hidden = false;
      $('hw-error').textContent = 'Напиши своє імʼя, щоб було видно, хто записав.';
      return;
    }
    store.set('name', name);
    $('hw-save').disabled = true;
    try {
      const r = await api.setHw(date, n + 1, text, name);
      delete hw[hwKey(date, n)];
      Object.assign(hw, r.hw);
      buzz(10);
      closeSheet();
      renderHwAll();
      toast(text ? 'Домашку збережено' : 'Запис стерто');
    } catch (err) {
      $('hw-error').textContent = err.code === 'slow' ? SLOW : err.code === 'date' ? 'На цей день записувати вже не можна.' : 'Не вдалося зберегти. Перевір інтернет і спробуй ще раз.';
    } finally {
      $('hw-save').disabled = false;
    }
  }
  $('hw-form').addEventListener('submit', e => {
    e.preventDefault();
    saveHw($('hw-text').value.trim());
  });
  $('hw-clear').addEventListener('click', () => saveHw(''));
  $('hw-cancel').addEventListener('click', () => closeSheet());

  // вибір дня: на сьогодні — поточний або наступний урок, інакше перший; групу памʼятаємо
  function pickDate(date) {
    selDate = date;
    const list = slotsOf(date), now = kyivNow(), grp = store.get('group', 1);
    const prefer = arr => arr.find(sl => !sl.group || sl.group === grp) || arr[0];
    let pick = null;
    if (date === now.date) pick = prefer(list.filter(sl => now.min < BELLS[sl.n][1]));
    selSlot = (pick || prefer(list))?.id || null;
  }
  function pickSlot(id) {
    selSlot = id;
    const sl = slotOf(selDate, id);
    if (sl?.group) store.set('group', sl.group);
    renderSlots();
    renderRoom();
  }

  function renderDays() {
    const box = $('days'), today = kyivNow().date;
    box.style.setProperty('--n', bookDates.length);
    box.textContent = '';
    for (const d of bookDates) {
      const b = h('button', 'day');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(d === selDate));
      b.setAttribute('aria-label', `${DOW[dowOf(d)]}, ${longDate(d)}`);
      b.append(h('span', 'd-dow', DOW_S[dowOf(d)]), h('span', 'd-num', dayNum(d)));
      const bar = h('span', 'd-bar'), fill = h('i'), list = slotsOf(d), mine = myCount(d);
      fill.style.width = `${list.length ? (mine / list.length) * 100 : 0}%`;
      bar.append(fill);
      b.append(bar, h('span', 'd-today', mine ? `парта на ${mine} ${plural(mine, 'урок', 'уроки', 'уроків')}` : d === today ? 'сьогодні' : bookable(d, today) ? 'бронь відкрита' : ''));
      b.onclick = () => { pickDate(d); renderDays(); renderSlots(); renderRoom(); };
      box.append(b);
    }
    renderSlots();
  }

  // уроки обраного дня
  function renderSlots() {
    const box = $('slots');
    box.textContent = '';
    for (const sl of slotsOf(selDate)) {
      const mine = slotData(selDate, sl.id).mine;
      const b = h('button', `slot${sl.id === selSlot ? ' on' : ''}${mine ? ' has' : ''}`);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(sl.id === selSlot));
      b.setAttribute('aria-label', `${sl.n + 1} урок, ${sl.subj}${sl.group ? `, група ${sl.group}` : ''}`);
      b.append(h('b', '', sl.n + 1), h('span', '', `${SHORT[sl.subj] || sl.subj}${sl.group ? ` · гр.${sl.group}` : ''}`));
      b.onclick = () => pickSlot(sl.id);
      box.append(b);
    }
    box.querySelector('.slot.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderRoom() {
    const sl = selDate && slotOf(selDate, selSlot);
    if (!sl) { $('rows').textContent = ''; return; }
    const day = slotData(selDate, sl.id), ids = seatsOf(sl.layout), total = ids.length;
    const taken = Object.keys(day.seats).length;
    $('room-eyebrow').textContent = `${DOW_S[dowOf(selDate)]}, ${longDate(selDate)} · каб. ${sl.room}`;
    $('room-day').textContent = `${sl.n + 1} урок · ${sl.subj}${sl.group ? ` · гр. ${sl.group}` : ''}`;
    $('tally').innerHTML = `<b>${total - taken}</b>вільних із ${total}`;
    const open = bookable(selDate);
    $('room-note').hidden = open;
    $('room-note').textContent = 'Сьогодні бронювати вже не можна: парти бронюють напередодні.';
    // звична парта — остання, яку бронював у кабінеті з таким самим планом
    const fav = (store.get('favs', {}) || {})[sl.layout.join('-')];
    const favFree = open && !day.mine && ids.includes(fav) && !day.seats[fav];
    $('fav-btn').hidden = !favFree;
    if (favFree) {
      const f = seatName(fav);
      $('fav-btn').innerHTML = `<span>Сісти за свою звичну парту</span><b>ряд ${f.r}, парта ${f.d}</b>`;
    }
    $('room').classList.toggle('loading', !lastSync && api === server && $('demo').hidden);
    const rows = $('rows'), lay = sl.layout, R = lay.length, depth = Math.max(...lay);
    rows.style.setProperty('--rows', R);
    rows.textContent = '';
    for (let d = 1; d <= depth; d++) {
      rows.append(h('div', 'desk-no', d));
      for (let r = 1; r <= R; r++) {
        // у коротшому ряду ззаду порожньо
        if (d > lay[r - 1]) { rows.append(h('div', 'desk-gap')); continue; }
        const desk = h('div', 'desk');
        desk.append(seatButton(`${r}-${d}`, day, favFree && fav === `${r}-${d}`));
        rows.append(desk);
      }
    }
    rows.append(h('div'));
    for (let r = 1; r <= R; r++) rows.append(h('div', 'row-name', `${r} ряд`));
    fitNames();
    const sync = $('sync');
    sync.classList.remove('off');
    sync.textContent = api === demo ? 'демо' : lastSync ? `оновлено ${new Date(lastSync).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : '';
  }

  // імʼя на парті зменшується, доки не влізе
  function fitNames() {
    for (const el of $('rows').querySelectorAll('.nm')) {
      let fs = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollWidth > el.clientWidth + 0.5 && fs > 10) {
        fs -= 0.5;
        el.style.fontSize = `${fs}px`;
      }
    }
  }
  window.addEventListener('resize', () => { if (bookDates.length) renderRoom(); });
  document.fonts?.ready.then(() => { if (bookDates.length) renderRoom(); });

  let popSeat = null;
  function seatButton(id, day, isFav) {
    const b = h('button', 'seat');
    b.type = 'button';
    b.dataset.seat = id;
    const who = day.seats[id];
    const label = seatName(id).text;
    if (!who) {
      b.classList.add('free');
      if (isFav) {
        b.classList.add('fav');
        b.append(h('span', 'fav-label', 'звична'));
      } else b.append(h('span', 'plus', '+'));
      b.setAttribute('aria-label', `${label}: вільна`);
    } else {
      const first = who.name.split(/\s+/)[0];
      b.classList.add(day.mine === id ? 'mine' : 'taken');
      b.append(h('span', 'nm', first));
      b.setAttribute('aria-label', `${label}: ${day.mine === id ? 'твоя парта' : who.name}`);
    }
    if (popSeat === id) { b.classList.add('pop'); popSeat = null; }
    b.onclick = () => onSeat(id);
    return b;
  }

  function onSeat(id) {
    const day = slotData(selDate, selSlot), who = day.seats[id];
    if (who && day.mine !== id) return isAdmin ? openAdminSeat(id, who) : toast(`${who.name} · ${seatName(id).text}`);
    if (!who && !bookable(selDate) && !canBookOthers()) return toast('Бронювати можна лише напередодні');
    openSheet(id);
  }

  // інші уроки цього дня в тому самому кабінеті, де ця парта вільна або вже твоя
  // Уроки цього дня в тому ж кабінеті, де ця парта вільна (або вже твоя): бронюються одним натиском.
  // Групові уроки — лише своєї групи (якщо відкрито груповий урок), щоб не займати парту в чужій групі.
  function sameRoomSlots(seat) {
    const cur = slotOf(selDate, selSlot);
    return slotsOf(selDate).filter(sl => sl.room === cur.room && sl.layout.join() === cur.layout.join() &&
      (!sl.group || sl.group === cur.group) &&
      (!slotData(selDate, sl.id).seats[seat] || slotData(selDate, sl.id).mine === seat));
  }
  // твої уроки цього дня з цією партою в цьому кабінеті — звільняються разом
  function myRoomSlots(seat) {
    const cur = slotOf(selDate, selSlot);
    return slotsOf(selDate).filter(sl => sl.room === cur.room && sl.layout.join() === cur.layout.join() &&
      slotData(selDate, sl.id).mine === seat);
  }
  const lessonsWord = n => `${n} ${plural(n, 'урок', 'уроки', 'уроків')}`;

  // ---------- аркуш ----------
  let sheetSeat = null;
  function openSheet(id) {
    sheetSeat = id;
    const day = slotData(selDate, selSlot), sl = slotOf(selDate, selSlot);
    const mine = day.mine === id, sn = seatName(id);
    $('sheet-eyebrow').textContent = `${DOW[dowOf(selDate)]}, ${longDate(selDate)} · ${sl.n + 1} урок, ${SHORT[sl.subj] || sl.subj}`;
    $('sheet-title').textContent = `Ряд ${sn.r} · парта ${sn.d}`;
    $('sheet-error').textContent = '';
    $('sheet-form').hidden = mine;
    $('sheet-mine').hidden = !mine;
    $('sheet-admin').hidden = true;
    $('sheet-release-all').hidden = true;
    if (mine) {
      const k = myCount(selDate), here = myRoomSlots(id).length;
      $('sheet-text').innerHTML = here > 1
        ? `Це твоя парта в каб. ${sl.room} на ${lessonsWord(here)}. Звільни її, якщо не прийдеш або хочеш пересісти.`
        : 'Це твоя парта на цьому уроці. Звільни її, якщо не прийдеш або хочеш пересісти.';
      $('sheet-release').textContent = here > 1 ? `Звільнити в каб. ${sl.room} · ${lessonsWord(here)}` : 'Звільнити парту';
      $('sheet-release-all').hidden = k <= here;
      $('sheet-release-all').textContent = `Звільнити всі ${k} ${plural(k, 'урок', 'уроки', 'уроків')} цього дня`;
    } else {
      const was = day.mine ? seatName(day.mine) : null;
      const all = sameRoomSlots(id);
      // одна бронь — одразу на всі уроки цього дня в цьому кабінеті
      const subjs = [...new Set(all.map(x => SHORT[x.subj] || x.subj))].join(', ');
      $('sheet-text').innerHTML = all.length > 1
        ? `Каб. ${sl.room}: парта буде твоя на ${lessonsWord(all.length)} — ${all.map(x => x.n + 1).join(', ')} (${subjs}).${was ? ` Попередня парта звільниться.` : ''}`
        : was ? `На цьому уроці твоя парта зараз — ряд ${was.r}, парта ${was.d}. Вона звільниться.` : `${sl.subj}, каб. ${sl.room}.`;
      $('sheet-submit').textContent = was ? 'Пересісти сюди' : 'Забронювати парту';
      // староста може бронювати для інших, а на закритий день — лише так
      $('for-other-row').hidden = !canBookOthers();
      $('for-other').checked = canBookOthers() && !bookable(selDate);
      $('for-other').disabled = canBookOthers() && !bookable(selDate);
      forOther();
    }
    $('scrim').hidden = false;
    $('sheet').hidden = false;
    if (!mine && !$('name-input').value) setTimeout(() => $('name-input').focus(), 250);
  }
  // староста знімає чужу бронь
  function openAdminSeat(id, who) {
    sheetSeat = id;
    const sn = seatName(id);
    $('sheet-eyebrow').textContent = `${DOW[dowOf(selDate)]}, ${longDate(selDate)} · староста`;
    $('sheet-title').textContent = `Ряд ${sn.r} · парта ${sn.d}`;
    $('sheet-text').textContent = `Зайняв(ла): ${who.name} — зняти цю бронь?`;
    $('sheet-error').textContent = '';
    $('sheet-form').hidden = true;
    $('sheet-mine').hidden = true;
    $('sheet-admin').hidden = false;
    $('sheet-release-all').hidden = true;
    $('scrim').hidden = false;
    $('sheet').hidden = false;
  }
  $('sheet-admin-release').addEventListener('click', async () => {
    const date = selDate;
    try {
      const r = await api.adminRelease(date, selSlot, sheetSeat);
      data[date] = cleanDay(r.day, date);
      closeSheet();
      renderDays();
      renderRoom();
      toast('Бронь знято');
    } catch {
      $('sheet-error').textContent = 'Не вдалося зняти бронь. Спробуй ще раз.';
    }
  });
  $('sheet-admin-close').addEventListener('click', () => closeSheet());

  function closeSheet() {
    for (const id of ['scrim', 'sheet', 'hw-sheet', 'poll-sheet', 'admin-sheet']) $(id).hidden = true;
    sheetSeat = null;
    hwOpen = null;
  }

  const isForOther = () => canBookOthers() && $('for-other').checked;
  function forOther() {
    const other = isForOther();
    $('name-label').textContent = other ? 'Для кого' : 'Імʼя та прізвище';
    $('name-input').placeholder = other ? 'Імʼя того, кому бронюєш' : 'Як тебе підписати на парті';
    $('name-input').value = other ? '' : store.get('name', '');
  }
  $('for-other').addEventListener('change', forOther);
  function sheetName() {
    const name = $('name-input').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) { $('sheet-error').textContent = 'Напиши імʼя, щоб усі бачили, чия це парта.'; return null; }
    if (!isForOther()) store.set('name', name);
    return name;
  }
  async function submitBooking(slots, btn) {
    const name = sheetName();
    if (!name) return;
    btn.disabled = true;
    const err = await bookSeat(sheetSeat, selDate, slots, name, isForOther());
    btn.disabled = false;
    if (err) $('sheet-error').textContent = err;
  }
  $('sheet-form').addEventListener('submit', e => {
    e.preventDefault();
    const ids = sameRoomSlots(sheetSeat).map(sl => sl.id);
    submitBooking(ids.length ? ids : [selSlot], $('sheet-submit'));
  });

  // повертає текст помилки або null
  async function bookSeat(seat, date, slots, name, other = false) {
    try {
      const r = await (other ? api.adminBook(date, slots, seat, name) : api.book(date, slots, seat, name));
      data[date] = cleanDay(r.day, date);
      const sl = slotOf(date, selSlot);
      if (sl && !other) store.set('favs', { ...(store.get('favs', {}) || {}), [sl.layout.join('-')]: seat });
      popSeat = seat;
      buzz([12, 50, 18]);
      closeSheet();
      renderDays();
      renderRoom();
      renderDigest();
      const k = r.booked?.length || 1, miss = r.taken?.length || 0;
      const whose = other ? `Заброньовано для ${name}` : 'Парта твоя';
      haptic();
      toast(k > 1 ? `${whose} на ${k} ${plural(k, 'урок', 'уроки', 'уроків')}${miss ? `; на ${miss} — уже зайнята` : ''}` : `${whose} ${DOW_ON[dowOf(date)]}`);
      return null;
    } catch (err) {
      if (err.code === 'taken') refresh();
      return err.code === 'taken' ? 'Хтось щойно зайняв цю парту. Обери іншу.'
        : err.code === 'slow' ? SLOW
        : err.code === 'date' ? 'На цей день бронювати не можна: тільки напередодні.'
        : 'Не вдалося забронювати. Перевір інтернет і спробуй ще раз.';
    }
  }
  $('fav-btn').addEventListener('click', async () => {
    const sl = slotOf(selDate, selSlot), fav = (store.get('favs', {}) || {})[sl.layout.join('-')], name = store.get('name', '');
    if (!name) return openSheet(fav);
    sheetSeat = fav;
    $('fav-btn').disabled = true;
    const err = await bookSeat(fav, selDate, sameRoomSlots(fav).map(x => x.id), name);
    $('fav-btn').disabled = false;
    if (err) toast(err);
  });
  async function release(slots, btn) {
    const date = selDate;
    btn.disabled = true;
    try {
      const r = await api.release(date, slots);
      data[date] = cleanDay(r.day, date);
      buzz(10);
      closeSheet();
      renderDays();
      renderRoom();
      renderDigest();
      toast(slots.length > 1 ? 'Парти на цей день звільнено' : 'Парту звільнено');
    } catch {
      $('sheet-error').textContent = 'Не вдалося звільнити парту. Спробуй ще раз.';
    } finally {
      btn.disabled = false;
    }
  }
  $('sheet-release').addEventListener('click', () => {
    const ids = myRoomSlots(sheetSeat).map(sl => sl.id);
    release(ids.length ? ids : [selSlot], $('sheet-release'));
  });
  $('sheet-release-all').addEventListener('click', () =>
    release(slotsOf(selDate).filter(sl => slotData(selDate, sl.id).mine).map(sl => sl.id), $('sheet-release-all')));
  for (const id of ['sheet-cancel', 'sheet-close', 'scrim']) $(id).addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('scrim').hidden) closeSheet(); });

  const buzz = p => { try { navigator.vibrate?.(p); } catch {} };

  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.hidden = true;
    t.textContent = text;
    void t.offsetWidth;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- опитування ----------
  let pollsKey = '';
  function renderPolls() {
    // перемальовуємо лише коли щось змінилось — інакше оновлення кожні 10 с скидало б «Точно видалити?»
    const key = JSON.stringify(polls) + isAdmin;
    if (key === pollsKey) return;
    pollsKey = key;
    const box = $('polls-list');
    box.textContent = '';
    if (!polls.length) {
      box.append(h('p', 'polls-empty', 'Поки опитувань немає. Створи перше — наприклад, куди йдемо після уроків.'));
      return;
    }
    for (const p of polls) {
      const card = h('article', 'poll');
      card.append(h('h3', 'poll-q', p.q));
      card.append(h('div', 'poll-meta', `${p.by}, ${ago(p.at)} · ${p.total} ${plural(p.total, 'голос', 'голоси', 'голосів')}`));
      const opts = h('div', 'poll-opts');
      const top = Math.max(...p.counts);
      p.options.forEach((o, i) => {
        const pct = p.total ? Math.round((p.counts[i] / p.total) * 100) : 0;
        const b = h('button', `opt${p.mine === i ? ' mine' : ''}${p.total && p.counts[i] === top ? ' lead' : ''}`);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(p.mine === i));
        const bar = h('span', 'opt-bar');
        bar.style.width = `${pct}%`;
        b.append(bar, h('span', 'opt-t', o), h('span', 'opt-c', `${p.counts[i]} · ${pct}%`));
        b.onclick = () => votePoll(p, p.mine === i ? null : i);
        opts.append(b);
      });
      card.append(opts);
      if (p.own || isAdmin) {
        const del = h('button', 'link-btn poll-del', 'Видалити опитування');
        del.type = 'button';
        del.onclick = () => deletePoll(p, del);
        card.append(del);
      }
      box.append(card);
    }
  }

  async function votePoll(p, option) {
    try {
      ({ polls } = await api.vote(p.id, option));
      buzz(8);
      renderPolls();
      if (option == null) toast('Голос знято');
    } catch (e) {
      toast(e.code === 'slow' ? SLOW : 'Не вдалося проголосувати. Спробуй ще раз.');
    }
  }

  // видалення в два натискання, бо confirm() на телефонах незручний
  async function deletePoll(p, btn) {
    if (!btn.dataset.sure) {
      btn.dataset.sure = '1';
      btn.textContent = 'Точно видалити? Натисни ще раз';
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.sure; btn.textContent = 'Видалити опитування'; } }, 4000);
      return;
    }
    try {
      ({ polls } = await api.deletePoll(p.id));
      renderPolls();
      toast('Опитування видалено');
    } catch {
      toast('Не вдалося видалити. Спробуй ще раз.');
    }
  }

  function pollInput(value = '') {
    const box = $('poll-inputs'), n = box.children.length + 1;
    const input = h('input');
    input.id = `poll-opt-${n}`;
    input.maxLength = 60;
    input.placeholder = `Варіант ${n}`;
    input.value = value;
    box.append(input);
    $('poll-add').hidden = box.children.length >= 6;
    return input;
  }
  $('poll-new').addEventListener('click', () => {
    $('poll-q').value = '';
    $('poll-inputs').textContent = '';
    pollInput();
    pollInput();
    const name = store.get('name', '');
    $('poll-name').value = name;
    $('poll-name-field').hidden = !!name;
    $('poll-error').textContent = '';
    $('scrim').hidden = false;
    $('poll-sheet').hidden = false;
    setTimeout(() => $('poll-q').focus(), 250);
  });
  $('poll-add').addEventListener('click', () => pollInput().focus());
  $('poll-cancel').addEventListener('click', () => closeSheet());
  $('poll-form').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('poll-q').value.trim();
    const options = [...$('poll-inputs').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    const name = $('poll-name').value.trim().replace(/\s+/g, ' ');
    const err = msg => { $('poll-error').textContent = msg; };
    if (q.length < 3) return err('Напиши питання.');
    if (options.length < 2) return err('Потрібно хоча б два варіанти.');
    if (new Set(options).size !== options.length) return err('Варіанти не мають повторюватися.');
    if (name.length < 2) { $('poll-name-field').hidden = false; return err('Напиши своє імʼя.'); }
    store.set('name', name);
    $('poll-save').disabled = true;
    try {
      ({ polls } = await api.createPoll(q, options, name));
      closeSheet();
      renderPolls();
      toast('Опитування створено');
    } catch (e2) {
      err(e2.code === 'limit' ? 'Можна мати до 3 опитувань одночасно. Видали старе.' : e2.code === 'slow' ? SLOW : 'Не вдалося створити. Перевір інтернет і спробуй ще раз.');
    } finally {
      $('poll-save').disabled = false;
    }
  });

  // ---------- зведення під шапкою ----------
  function renderDigest() {
    if (!bookDates.length) return;
    const now = kyivNow();
    // парти: сьогодні, поки йдуть уроки й є броні, інакше день, який можна бронювати
    const today = now.date, next = bookDates[bookDates.length - 1];
    const deskDay = myCount(today) && !dayOver(now) ? today : next;
    const short = d => (d === today ? 'сьогодні' : d === addDays(today, 1) ? 'завтра' : DOW_S[dowOf(d)]);
    const list = slotsOf(deskDay), mineSlots = list.filter(sl => slotData(deskDay, sl.id).mine);
    const seats = new Set(mineSlots.map(sl => slotData(deskDay, sl.id).mine));
    $('dg-desk-k').textContent = `Парта ${deskDay === today ? 'сьогодні' : 'на ' + short(deskDay)}`;
    $('dg-desk-v').textContent = !mineSlots.length ? (bookable(deskDay) ? 'забронюй' : 'немає')
      : mineSlots.length === list.length && seats.size === 1 ? `ряд ${seatName([...seats][0]).r} · ${seatName([...seats][0]).d}`
      : `${mineSlots.length} з ${list.length} ур.`;
    $('dg-desk').classList.toggle('cta', !mineSlots.length && bookable(deskDay));
    $('dg-desk').onclick = () => { pickDate(deskDay); renderDays(); renderRoom(); goTab('desks'); };
    // домашка на найближчий день
    const hd = hwDates[0];
    if (hd) {
      const n = hwCount(hd), dn = doneCount(hd);
      $('dg-hw-k').textContent = `Д/з ${hd === today ? 'на сьогодні' : 'на ' + short(hd)}`;
      $('dg-hw-v').textContent = !n ? 'нічого' : dn ? `${dn} з ${n} ✓` : `${n} ${plural(n, 'предмет', 'предмети', 'предметів')}`;
      $('dg-hw').classList.toggle('ok', n > 0 && dn === n);
      $('dg-hw').onclick = () => { hwSel = hd; renderHwPanel(); goTab('hw'); };
    }
    // чат
    const seen = store.get('chatSeen', 0), fresh = chatMsgs.filter(m => m.id > seen && !m.own).length;
    $('dg-chat-v').textContent = fresh ? `${fresh} ${plural(fresh, 'нове', 'нових', 'нових')}` : chatMsgs.length ? 'прочитано' : 'тихо';
    $('dg-chat').classList.toggle('hot', fresh > 0);
    $('dg-chat').onclick = () => { showCView('chat'); goTab('chat'); };
  }
  function goTab(name) {
    showTab(name);
    $('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- чат ----------
  let chatMsgs = [], chatLast = 0, chatRev = 0, pickFor = null;
  const EMOJI = ['👍', '😂', '❤️', '🔥'];
  function mergeChat(c) {
    if (!c) return;
    const before = chatLast;
    chatMsgs = c.full ? c.msgs : chatMsgs.concat(c.msgs.filter(m => m.id > chatLast));
    chatRev = c.rev;
    chatLast = chatMsgs.length ? chatMsgs[chatMsgs.length - 1].id : 0;
    if (c.full || chatLast !== before) renderChat();
    updateUnread();
  }
  const chatOpen = () => currentTab === 'chat' && cview === 'chat' && !document.hidden;
  function updateUnread() {
    if (chatOpen()) store.set('chatSeen', chatLast);
    const seen = store.get('chatSeen', 0);
    $('unread').hidden = !chatMsgs.some(m => m.id > seen && !m.own);
    renderDigest();
  }
  const hm = at => new Date(at).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
  const kyivDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(at));

  function renderChat() {
    const box = $('chat-list');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = '';
    if (!chatMsgs.length) {
      box.append(h('p', 'chat-empty', 'Тут поки тихо. Напиши першим.'));
      return;
    }
    const today = kyivNow().date;
    let prev = null;
    for (const m of chatMsgs) {
      const d = kyivDate(m.at);
      if (!prev || kyivDate(prev.at) !== d) {
        box.append(h('div', 'chat-day', d === today ? 'Сьогодні' : d === addDays(today, -1) ? 'Вчора' : longDate(d)));
        prev = null;
      }
      const cont = prev && prev.by === m.by && prev.own === m.own && m.at - prev.at < 5 * 60e3;
      const el = h('div', `msg ${m.own ? 'own' : 'other'}${cont ? ' cont' : ''}`);
      if (!cont) {
        const head = h('div', 'msg-head');
        head.append(h('b', '', m.own ? 'Ти' : m.by), h('time', '', hm(m.at)));
        el.append(head);
      }
      const bubble = h('div', 'bubble');
      bubble.append(h('span', 'msg-text', m.text));
      // торкнутись повідомлення — відкрити реакції
      bubble.onclick = e => {
        if (e.target.closest('.msg-del')) return;
        pickFor = pickFor === m.id ? null : m.id;
        renderChat();
      };
      if (m.own || isAdmin) {
        const del = h('button', 'msg-del', '×');
        del.type = 'button';
        del.setAttribute('aria-label', 'Видалити повідомлення');
        del.onclick = () => deleteMsg(m, del);
        bubble.append(del);
      }
      el.append(bubble);
      const re = Object.entries(m.re || {}).filter(([, v]) => v.n > 0);
      if (re.length || pickFor === m.id) {
        const row = h('div', 're-row');
        for (const [emo, v] of re) {
          const pill = h('button', `re-pill${v.mine ? ' mine' : ''}`, `${emo} ${v.n}`);
          pill.type = 'button';
          pill.onclick = () => react(m.id, emo);
          row.append(pill);
        }
        if (pickFor === m.id) {
          for (const emo of EMOJI) {
            const b = h('button', 're-pick', emo);
            b.type = 'button';
            b.setAttribute('aria-label', `Реакція ${emo}`);
            b.onclick = () => react(m.id, emo);
            row.append(b);
          }
        }
        el.append(row);
      }
      box.append(el);
      prev = m;
    }
    if (nearBottom || chatMsgs[chatMsgs.length - 1]?.own) box.scrollTop = box.scrollHeight;
  }

  async function react(id, emoji) {
    pickFor = null;
    try {
      await api.react(id, emoji);
      buzz(6);
      await refresh();
    } catch (e) {
      toast(e.code === 'slow' ? SLOW : 'Не вдалося поставити реакцію.');
    }
  }

  async function deleteMsg(m, btn) {
    if (!btn.dataset.sure) {
      btn.dataset.sure = '1';
      btn.textContent = 'видалити?';
      btn.classList.add('sure');
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.sure; btn.textContent = '×'; btn.classList.remove('sure'); } }, 4000);
      return;
    }
    try {
      await api.deleteChat(m.id);
      chatMsgs = chatMsgs.filter(x => x.id !== m.id);
      renderChat();
      refresh();
    } catch {
      toast('Не вдалося видалити.');
    }
  }

  function chatResize() {
    const t = $('chat-text');
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
  }
  $('chat-text').addEventListener('input', chatResize);
  $('chat-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat-form').requestSubmit(); }
  });
  $('chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('chat-text').value.trim();
    if (!text) return;
    let name = store.get('name', '');
    if (!name) {
      const n = $('chat-name').value.trim().replace(/\s+/g, ' ');
      if (n.length < 2) {
        $('chat-name').hidden = false;
        $('chat-name').focus();
        return toast('Спершу напиши своє імʼя');
      }
      store.set('name', (name = n));
      $('chat-name').hidden = true;
    }
    $('chat-send').disabled = true;
    try {
      await api.sendChat(text, name);
      $('chat-text').value = '';
      chatResize();
      await refresh();
      $('chat-list').scrollTop = $('chat-list').scrollHeight;
    } catch (err) {
      toast(err.code === 'slow' ? 'Забагато повідомлень. Зачекай хвилину.' : 'Не вдалося надіслати. Перевір інтернет.');
    } finally {
      $('chat-send').disabled = false;
    }
  });

  // ---------- староста ----------
  // Вхід прихований: 5 швидких торкань по «8-Б». У режимі старости риска в «8-Б» стає синьою — помітно лише тому, хто знає.
  function adminUi() {
    document.documentElement.classList.toggle('is-admin', isAdmin || isBooker);
    pollsKey = '';
    renderPolls();
    renderChat();
    renderRoom();
  }
  let taps = [];
  $('klass').addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter(t => now - t < 2500).concat(now);
    if (taps.length >= 5) { taps = []; openAdmin(); }
  });
  async function openAdmin() {
    $('admin-error').textContent = '';
    const on = isAdmin || isBooker;
    $('admin-form').hidden = on;
    $('admin-on').hidden = !on;
    $('admin-title').textContent = isAdmin ? 'Режим старости' : isBooker ? 'Режим помічника' : 'Код';
    $('admin-text').textContent = isAdmin
      ? 'Можна бронювати парти для інших (і на сьогодні), знімати будь-які броні, видаляти опитування й повідомлення. Останні дії:'
      : isBooker
        ? 'Можна бронювати парти для інших — скільки завгодно і на сьогодні теж: торкнись вільної парти й постав «Для іншої людини».'
        : 'Введи код старости або помічника.';
    $('admin-code').value = '';
    $('scrim').hidden = false;
    $('admin-sheet').hidden = false;
    if (!on) return setTimeout(() => $('admin-code').focus(), 250);
    const list = $('admin-log');
    list.textContent = '';
    list.hidden = !isAdmin;
    $('tg-setup').hidden = !isAdmin;
    $('tg-status').hidden = !isAdmin;
    if (!isAdmin) return;
    loadTgStatus();
    try {
      const { log } = await api.adminLog();
      if (!log.length) list.append(h('li', 'muted', 'Поки нічого.'));
      for (const e of log) {
        const li = h('li');
        li.append(h('b', '', e.action), h('span', '', ` ${e.detail}`), h('time', '', ago(e.at)));
        list.append(li);
      }
    } catch {
      list.append(h('li', 'muted', 'Не вдалося завантажити журнал.'));
    }
  }
  function exitAdmin(silent) {
    isAdmin = false;
    isBooker = false;
    adminKey = null;
    store.set('admin', null);
    store.set('role', null);
    closeSheet();
    adminUi();
    if (silent !== true) toast('Режим вимкнено');
  }
  $('admin-exit').addEventListener('click', exitAdmin);
  // Telegram-бот: сервер сам прописує вебхук і меню команд, якщо в Cloudflare є секрет TG_TOKEN
  async function loadTgStatus() {
    const el = $('tg-status');
    el.textContent = 'Бот: перевіряю…';
    try {
      const r = await api.tgStatus();
      el.textContent = !r.token ? 'Бот: у Cloudflare немає секрету TG_TOKEN.'
        : !r.ok ? `Бот: Telegram не відповідає (${r.detail || 'невідома помилка'}).`
        : r.hooked ? `Бот @${r.username} підключено.${r.lastError ? ` Остання помилка Telegram: ${r.lastError}.` : ''}`
        : `Бот @${r.username} знайдено, але ще не підключено — натисни кнопку.`;
    } catch (e) {
      el.textContent = e.code === 'timeout' ? 'Бот: сервер не відповів за 25 с.' : 'Бот: не вдалося перевірити стан.';
    }
  }
  $('tg-setup').addEventListener('click', async () => {
    const btn = $('tg-setup'), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Підключаю…';
    $('admin-error').textContent = '';
    try {
      const r = await api.tgSetup();
      toast(`Бот @${r.username} підключено`);
    } catch (e) {
      const why = e.detail ? ` (${e.detail})` : '';
      $('admin-error').textContent = e.code === 'no_token' ? 'Спершу додай секрет TG_TOKEN у Cloudflare.'
        : e.code === 'bad_token' ? `Telegram не прийняв токен${why}. Перевір TG_TOKEN у Cloudflare.`
        : e.code === 'unreachable' ? `Сервер не достукався до Telegram${why}.`
        : e.code === 'webhook' ? `Telegram не прийняв адресу бота${why}.`
        : e.code === 'timeout' ? 'Сервер не відповів за 25 с. Спробуй ще раз.'
        : `Не вдалося підключити бота${e.status ? ` (HTTP ${e.status})` : ''}. Спробуй ще раз.`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      loadTgStatus();
    }
  });
  $('admin-close').addEventListener('click', () => closeSheet());
  $('admin-cancel').addEventListener('click', () => closeSheet());
  $('admin-form').addEventListener('submit', async e => {
    e.preventDefault();
    const key = $('admin-code').value.trim().toUpperCase();
    if (!key) return;
    adminKey = key;
    let r = {}, blocked = false;
    try { r = await api.adminCheck(); } catch (err) { blocked = err.code === 'blocked'; }
    if (!r.admin && !r.booker) {
      adminKey = null;
      $('admin-error').textContent = blocked ? 'Забагато спроб. Спробуй через 15 хвилин.' : 'Код не підходить.';
      return;
    }
    isAdmin = !!r.admin;
    isBooker = !r.admin && !!r.booker;
    store.set('admin', key);
    store.set('role', isAdmin ? 'admin' : 'booker');
    closeSheet();
    adminUi();
    toast(isAdmin ? 'Режим старости увімкнено' : 'Режим помічника увімкнено');
  });
  // код змінився або став недійсним — тихо виходимо
  if (adminKey) api.adminCheck().then(r => {
    if (isAdmin && !r.admin) exitAdmin(true);
    else if (isBooker && !r.booker) exitAdmin(true);
  }).catch(() => {});

  // ---------- оновлення ----------
  // Частота: чат відкритий — 4 с, звичайно — 10 с, без дій понад 5 хв або вкладка прихована — 60 с.
  let lastActive = Date.now(), pollTimer = null;
  const idle = () => Date.now() - lastActive > 5 * 60e3;
  for (const ev of ['pointerdown', 'keydown', 'scroll']) {
    addEventListener(ev, () => {
      const wasIdle = idle();
      lastActive = Date.now();
      if (wasIdle) { refresh(); schedule(); }
    }, { passive: true });
  }
  function schedule() {
    clearTimeout(pollTimer);
    const wait = document.hidden || idle() ? 60e3 : chatOpen() ? 4e3 : 10e3;
    pollTimer = setTimeout(async () => {
      if (!document.hidden && api === server) await refresh();
      schedule();
    }, wait);
  }

  // ---------- розклад ----------
  let weekSel = null;
  function weekDates(now) {
    // поточний тиждень; у суботу й неділю — наступний
    const shift = now.dow === 0 ? 1 : now.dow === 6 ? 2 : 1 - now.dow;
    const mon = addDays(now.date, shift);
    return [0, 1, 2, 3, 4].map(i => addDays(mon, i));
  }
  function renderWeek(now, st) {
    const dates = weekDates(now);
    if (!weekSel || !dates.includes(weekSel)) weekSel = dates.includes(now.date) ? now.date : dates[0];
    const chips = $('week-days');
    chips.textContent = '';
    const box = $('week-grid');
    box.textContent = '';
    dates.forEach((date, i) => {
      const isToday = date === now.date;
      const chip = h('button', 'day');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(date === weekSel));
      chip.append(h('span', 'd-dow', DOW_S[i + 1]), h('span', 'd-num', dayNum(date)), h('span', 'd-today', isToday ? 'сьогодні' : ''));
      chip.onclick = () => { weekSel = date; renderWeek(kyivNow(), status(kyivNow())); };
      chips.append(chip);

      const raw = C.week[i], L = lessonsOn(date), { first, last, count } = span(L);
      const col = h('div', `wday${isToday ? ' is-today' : ''}${date === weekSel ? ' shown' : ''}`);
      const head = h('div', 'wday-head');
      head.append(h('span', 'wday-name', `${cap(DOW[i + 1])}, ${dayNum(date)}`), h('span', 'wday-meta', `${count} ${plural(count, 'урок', 'уроки', 'уроків')}`));
      col.append(head);
      for (let n = 0; n <= last; n++) {
        const l = L[n];
        if (!l && n > first) continue;
        const row = h('div', 'lesson');
        row.append(h('div', 'n', n + 1));
        const body = h('div', 'body');
        const time = `${fmt(BELLS[n][0])}–${fmt(BELLS[n][1])}`;
        if (!l) {
          row.classList.add('empty');
          body.append(h('div', 'subj', 'немає уроку'), meta(time));
        } else {
          body.append(h('div', 'subj', l.s || 'Дві групи'));
          if (l.g) {
            body.append(meta(time));
            l.g.forEach((g, gi) => {
              const grp = h('div', 'grp');
              grp.append(h('span', `k ${g.k ? (g.k === 'A' ? 'ka' : 'kb') : ''}`, g.k || `гр. ${gi + 1}`));
              const line = h('span');
              if (g.s) line.append(h('span', 's', g.s), document.createTextNode(' · '));
              line.append(document.createTextNode(`${g.t} · `), h('span', 'room-tag', g.r));
              grp.append(line);
              body.append(grp);
            });
          } else {
            body.append(meta(time, l.t, l.r));
          }
          if (raw[n].alt) body.append(h('div', 'alt-note', `наступного тижня — ${subjOf(raw[n].alt[1 - weekNo(date)])}`));
          const item = hw[hwKey(date, n)];
          if (item) body.append(h('div', `hw-text${isDone(hwKey(date, n)) ? ' is-done' : ''}`, item.text));
          row.onclick = () => openHw(date, n);
          if (isToday && st.lesson === n) row.classList.add('now');
          else if (isToday && now.min >= BELLS[n][1]) row.classList.add('past');
        }
        row.append(body);
        col.append(row);
      }
      box.append(col);
    });
  }
  function meta(time, who, room) {
    const m = h('div', 'meta');
    m.append(h('span', 'time', time));
    if (who) m.append(h('span', '', who));
    if (room) m.append(h('span', 'room-tag', `каб. ${room}`));
    return m;
  }

  // ---------- дзвінки ----------
  function renderBells(now, st) {
    const used = Math.max(...C.week.map(L => span(L).last)) + 1;
    const box = $('bells-list');
    box.textContent = '';
    const school = !!lessonsOf(now.dow);
    BELLS.forEach(([a, b], i) => {
      const li = h('li', `bell${i >= used ? ' off' : ''}`);
      li.append(h('span', 'n', i + 1), h('span', 't', `${fmt(a)} – ${fmt(b)}`));
      const inLesson = now.min >= a && now.min < b;
      li.append(h('span', 'left', inLesson ? `ще ${Math.ceil(b - now.min)} хв` : ''));
      if (inLesson) li.classList.add('now');
      box.append(li);
      if (i < BELLS.length - 1) {
        const len = BELLS[i + 1][0] - b, note = C.breakNotes[i + 1];
        const brk = h('li', `brk${len >= 15 ? ' big' : ''}`);
        brk.append(h('span', 'len', `${len} хв`));
        if (note) brk.append(h('span', 'note', note));
        if (now.min >= b && now.min < BELLS[i + 1][0]) brk.classList.add('now');
        box.append(brk);
      }
    });
    if (!school) box.querySelectorAll('.now').forEach(el => el.classList.remove('now'));
  }

  // ---------- вкладки ----------
  const TABS = ['desks', 'week', 'hw', 'chat'];
  let currentTab = 'desks', cview = 'chat';
  function showCView(v) {
    cview = v;
    for (const b of document.querySelectorAll('#chat-seg button')) b.setAttribute('aria-checked', String(b.dataset.cview === v));
    $('cview-chat').hidden = v !== 'chat';
    $('cview-polls').hidden = v !== 'polls';
    store.set('cview', v);
    if (chatOpen()) { updateUnread(); $('chat-list').scrollTop = $('chat-list').scrollHeight; refresh(); schedule(); }
  }
  document.querySelectorAll('#chat-seg button').forEach(b => b.addEventListener('click', () => showCView(b.dataset.cview)));
  function showView(view) {
    for (const b of document.querySelectorAll('.seg-ctl button[data-view]')) b.setAttribute('aria-checked', String(b.dataset.view === view));
    $('view-lessons').hidden = view !== 'lessons';
    $('view-bells').hidden = view !== 'bells';
    store.set('view', view);
  }
  document.querySelectorAll('.seg-ctl button[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  function showTab(name) {
    // дзвінки тепер усередині «Розкладу»
    if (name === 'bells') { showView('bells'); name = 'week'; }
    if (name === 'polls') { showCView('polls'); name = 'chat'; }
    if (!TABS.includes(name)) name = 'desks';
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
      $(`panel-${t}`).hidden = t !== name;
    }
    currentTab = name;
    store.set('tab', name);
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
    if (chatOpen()) { updateUnread(); $('chat-list').scrollTop = $('chat-list').scrollHeight; refresh(); schedule(); }
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  // ---------- свайп між днями ----------
  function onSwipe(el, fn) {
    let x0 = null, y0 = 0;
    el.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    el.addEventListener('touchend', e => {
      if (x0 == null) return;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) fn(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  function slide(el, dir) {
    el.classList.remove('slide-next', 'slide-prev');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  }
  onSwipe($('room'), dir => {
    const list = slotsOf(selDate), i = list.findIndex(sl => sl.id === selSlot) + dir;
    if (i < 0 || i >= list.length) return;
    pickSlot(list[i].id);
    slide($('room'), dir);
  });
  onSwipe($('week-grid'), dir => {
    if (!matchMedia('(max-width: 899px), (min-width: 1000px) and (max-width: 1299px)').matches) return;
    const now = kyivNow(), dates = weekDates(now), i = dates.indexOf(weekSel) + dir;
    if (i < 0 || i >= dates.length) return;
    weekSel = dates[i];
    renderWeek(now, status(now));
    slide($('week-grid'), dir);
  });

  // ---------- тема і посилання ----------
  const THEMES = { auto: 'як у телефоні', light: 'світла', dark: 'темна' };
  function applyTheme(mode) {
    const root = document.documentElement;
    // «авто» в Telegram — як тема самого Telegram
    const eff = mode === 'auto' && inTg && tgDark != null ? (tgDark ? 'dark' : 'light') : mode;
    if (eff === 'auto') delete root.dataset.theme;
    else root.dataset.theme = eff;
    $('theme').dataset.mode = mode;
    $('theme').setAttribute('aria-label', `Тема: ${THEMES[mode]}`);
    const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.content = eff === 'auto' ? (m.media.includes('dark') ? '#16201c' : '#f5f8fc') : paper;
    }
    requestAnimationFrame(tgColors);
  }
  $('theme').addEventListener('click', () => {
    const keys = Object.keys(THEMES), mode = keys[(keys.indexOf($('theme').dataset.mode) + 1) % keys.length];
    applyTheme(mode);
    store.set('theme', mode);
    toast(`Тема: ${THEMES[mode]}`);
  });
  $('share').addEventListener('click', async () => {
    const url = location.href.split('#')[0];
    try {
      if (navigator.share) { await navigator.share({ title: '8-Б', text: 'Парти, розклад і дзвінки 8-Б', url }); return; }
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    try { await navigator.clipboard.writeText(url); toast('Посилання скопійовано'); } catch { toast(url); }
  });
  $('strip').addEventListener('click', () => goTab('week'));

  // ---------- старт ----------
  document.documentElement.classList.add('intro');
  applyTheme(store.get('theme', 'auto'));
  $('year').textContent = C.year;
  $('rules').append(...C.rules.map(r => h('li', '', r)));
  showView(store.get('view', 'lessons'));
  cview = store.get('cview', 'chat');
  showCView(cview);
  if (isAdmin || isBooker) adminUi();
  showTab((tgLaunch ? '' : location.hash.slice(1)) || store.get('tab', 'desks'));
  if (inTg) {
    tgPost('web_app_setup_swipe_behavior', { allow_vertical_swipe: false }); // щоб прокрутка не згортала застосунок
    tgPost('web_app_expand');
    tgPost('web_app_ready');
  }
  tick();
  setInterval(tick, 1000);
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); updateUnread(); } schedule(); });
  // офлайн і встановлення на телефон (sw.js); у вбудованому перегляді просто не спрацює
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
