(() => {
  const C = window.CLASS;
  const $ = id => document.getElementById(id);
  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

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
    const L = lessonsOf(now.dow);
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
    const nd = nextSchoolDay(now.date), NL = lessonsOf(dowOf(nd)), { first } = span(NL);
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
    const date = stripDay(now), L = lessonsOf(dowOf(date)), { first, last, count } = span(L);
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

  // ---------- броні ----------
  // бронюється вся парта: id «ряд-парта»
  const seatName = id => { const [r, d] = id.split('-'); return { r, d, text: `ряд ${r}, парта ${d}` }; };
  const seatIds = [];
  for (let r = 1; r <= C.rows; r++) for (let d = 1; d <= C.desks; d++) seatIds.push(`${r}-${d}`);
  const TOTAL = seatIds.length;
  // старі броні окремих місць («1-2-L») не показуємо
  const cleanDay = day => {
    const seats = {};
    for (const id of seatIds) if (day.seats[id]) seats[id] = day.seats[id];
    return { seats, mine: seatIds.includes(day.mine) ? day.mine : null };
  };

  // Сервер: /api/days, /api/book, /api/release, /api/hw (src/worker.js). Якщо його немає — демо в localStorage.
  const server = {
    async req(path, body) {
      const r = await fetch((C.api || '').replace(/\/$/, '') + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-token': token },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw Object.assign(new Error('no api'), { noApi: true });
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data.error || 'error'), { code: data.code });
      return data;
    },
    days: dates => server.req(`/api/days?dates=${dates.join(',')}`),
    book: (date, seat, name) => server.req('/api/book', { date, seat, name }),
    release: date => server.req('/api/release', { date }),
    hw: (from, to) => server.req(`/api/hw?from=${from}&to=${to}`),
    setHw: (date, lesson, text, name) => server.req('/api/hw', { date, lesson, text, name }),
    hwHistory: (date, lesson) => server.req(`/api/hw/history?date=${date}&lesson=${lesson}`),
    polls: () => server.req('/api/polls'),
    createPoll: (q, options, name) => server.req('/api/polls', { q, options, name }),
    vote: (id, option) => server.req('/api/polls/vote', { id, option }),
    deletePoll: id => server.req('/api/polls/delete', { id }),
  };

  const demo = {
    all() { return store.get('demo-bookings-v3', {}); },
    day(all, date) { return (all[date] ||= { seats: {}, mine: null }); },
    async days(dates) {
      const all = demo.all(), days = {};
      for (const d of dates) days[d] = demo.view(demo.day(all, d));
      store.set('demo-bookings-v3', all);
      return { days };
    },
    view(day) {
      const seats = {};
      for (const [k, v] of Object.entries(day.seats)) seats[k] = { name: v.name };
      return { seats, mine: day.mine };
    },
    async book(date, seat, name) {
      const all = demo.all(), day = demo.day(all, date);
      if (day.seats[seat] && day.mine !== seat) throw Object.assign(new Error('taken'), { code: 'taken' });
      if (day.mine) delete day.seats[day.mine];
      day.seats[seat] = { name };
      day.mine = seat;
      store.set('demo-bookings-v3', all);
      return { day: demo.view(day) };
    },
    async release(date) {
      const all = demo.all(), day = demo.day(all, date);
      if (day.mine) delete day.seats[day.mine];
      day.mine = null;
      store.set('demo-bookings-v3', all);
      return { day: demo.view(day) };
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
    async polls() { return demo.pollView(); },
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
  let selDate = null;
  let data = {};          // date -> { seats: { id: { name } }, mine }
  let hw = {};            // "date|урок" -> { text, by, at }
  let polls = [];
  let lastSync = 0;

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
    if (!bookDates.includes(selDate)) selDate = dayOver(now) ? bookDates[bookDates.length - 1] : bookDates[0];
    renderDays();
    renderHwPanel();
    refresh();
  }

  async function refresh() {
    if (!bookDates.length) return;
    try {
      const week = weekDates(kyivNow());
      const [r, w, pl] = await Promise.all([api.days(bookDates), api.hw(week[0], addDays(week[0], 20)), api.polls()]);
      data = Object.fromEntries(Object.entries(r.days).map(([d, day]) => [d, cleanDay(day)]));
      hw = w.hw;
      polls = pl.polls;
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
  }

  // ---------- домашка ----------
  const hwKey = (date, n) => `${date}|${n + 1}`;
  const hwCount = date => {
    const L = lessonsOf(dowOf(date));
    return L ? L.filter((l, n) => l && hw[hwKey(date, n)]).length : 0;
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
      const b = h('button', 'day'), n = hwCount(d), L = lessonsOf(dowOf(d));
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
    const L = lessonsOf(dowOf(hwSel)), n = hwCount(hwSel), total = span(L).count;
    $('hw-day').textContent = `${cap(DOW[dowOf(hwSel)])}, ${longDate(hwSel)}`;
    $('hw-tally').innerHTML = `<b>${n}</b>записано з ${total}`;
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
      li.append(btn);
      list.append(li);
    });
  }

  let hwOpen = null;
  function openHw(date, n) {
    const L = lessonsOf(dowOf(date)), l = L && L[n];
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
      $('hw-error').textContent = err.code === 'date' ? 'На цей день записувати вже не можна.' : 'Не вдалося зберегти. Перевір інтернет і спробуй ще раз.';
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
      const bar = h('span', 'd-bar'), fill = h('i');
      const n = data[d] ? Object.keys(data[d].seats).length : 0;
      fill.style.width = `${(n / TOTAL) * 100}%`;
      bar.append(fill);
      b.append(bar, h('span', 'd-today', data[d]?.mine ? 'є парта' : d === today ? 'сьогодні' : bookable(d, today) ? 'бронь відкрита' : ''));
      b.onclick = () => { selDate = d; renderDays(); renderRoom(); };
      box.append(b);
    }
  }

  function renderRoom() {
    const day = data[selDate] || { seats: {}, mine: null };
    const taken = Object.keys(day.seats).length;
    $('room-day').textContent = `${cap(DOW[dowOf(selDate)])}, ${longDate(selDate)}`;
    $('tally').innerHTML = `<b>${TOTAL - taken}</b>вільних із ${TOTAL}`;
    const open = bookable(selDate);
    $('room-note').hidden = open;
    $('room-note').textContent = 'Сьогодні бронювати вже не можна: парти бронюють напередодні.';
    // звична парта — та, яку бронював минулого разу
    const fav = store.get('fav');
    const favFree = open && !day.mine && seatIds.includes(fav) && !day.seats[fav];
    $('fav-btn').hidden = !favFree;
    if (favFree) {
      const f = seatName(fav);
      $('fav-btn').innerHTML = `<span>Сісти за свою звичну парту</span><b>ряд ${f.r}, парта ${f.d}</b>`;
    }
    const rows = $('rows');
    rows.style.setProperty('--rows', C.rows);
    rows.textContent = '';
    for (let d = 1; d <= C.desks; d++) {
      rows.append(h('div', 'desk-no', d));
      for (let r = 1; r <= C.rows; r++) {
        const desk = h('div', 'desk');
        desk.append(seatButton(`${r}-${d}`, day, favFree && fav === `${r}-${d}`));
        rows.append(desk);
      }
    }
    rows.append(h('div'));
    for (let r = 1; r <= C.rows; r++) rows.append(h('div', 'row-name', `${r} ряд`));
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
    const day = data[selDate] || { seats: {}, mine: null };
    const who = day.seats[id];
    if (who && day.mine !== id) return toast(`${who.name} · ${seatName(id).text}`);
    if (!who && !bookable(selDate)) return toast('Бронювати можна лише напередодні');
    openSheet(id, day);
  }

  // ---------- аркуш ----------
  let sheetSeat = null;
  function openSheet(id, day) {
    sheetSeat = id;
    const mine = day.mine === id;
    const sn = seatName(id);
    $('sheet-eyebrow').textContent = `${DOW[dowOf(selDate)]}, ${longDate(selDate)}`;
    $('sheet-title').textContent = `Ряд ${sn.r} · парта ${sn.d}`;
    $('sheet-error').textContent = '';
    $('sheet-form').hidden = mine;
    $('sheet-mine').hidden = !mine;
    if (mine) {
      $('sheet-text').innerHTML = 'Це твоя парта. Звільни її, якщо не прийдеш або хочеш пересісти.';
    } else {
      const was = day.mine ? seatName(day.mine) : null;
      $('sheet-text').innerHTML = was
        ? `Твоя теперішня парта (ряд ${was.r}, парта ${was.d}) звільниться.`
        : 'Уся парта буде твоя на цей день.';
      $('sheet-submit').textContent = was ? 'Пересісти сюди' : 'Забронювати парту';
      $('name-input').value = store.get('name', '');
    }
    $('scrim').hidden = false;
    $('sheet').hidden = false;
    if (!mine && !$('name-input').value) setTimeout(() => $('name-input').focus(), 250);
  }
  function closeSheet() {
    for (const id of ['scrim', 'sheet', 'hw-sheet', 'poll-sheet']) $(id).hidden = true;
    sheetSeat = null;
    hwOpen = null;
  }

  $('sheet-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('name-input').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) { $('sheet-error').textContent = 'Напиши імʼя, щоб усі бачили, чия це парта.'; return; }
    store.set('name', name);
    $('sheet-submit').disabled = true;
    const err = await bookSeat(sheetSeat, selDate, name);
    $('sheet-submit').disabled = false;
    if (err) $('sheet-error').textContent = err;
  });

  // повертає текст помилки або null
  async function bookSeat(seat, date, name) {
    try {
      const r = await api.book(date, seat, name);
      data[date] = cleanDay(r.day);
      store.set('fav', seat);
      popSeat = seat;
      buzz([12, 50, 18]);
      closeSheet();
      renderDays();
      renderRoom();
      toast(`Парта твоя ${DOW_ON[dowOf(date)]}, ${longDate(date)}`);
      return null;
    } catch (err) {
      if (err.code === 'taken') refresh();
      return err.code === 'taken' ? 'Хтось щойно зайняв цю парту. Обери іншу.'
        : err.code === 'date' ? 'На цей день бронювати не можна: тільки напередодні.'
        : 'Не вдалося забронювати. Перевір інтернет і спробуй ще раз.';
    }
  }
  $('fav-btn').addEventListener('click', async () => {
    const fav = store.get('fav'), name = store.get('name', '');
    if (!name) return openSheet(fav, data[selDate] || { seats: {}, mine: null });
    $('fav-btn').disabled = true;
    const err = await bookSeat(fav, selDate, name);
    $('fav-btn').disabled = false;
    if (err) toast(err);
  });
  $('sheet-release').addEventListener('click', async () => {
    const date = selDate;
    $('sheet-release').disabled = true;
    try {
      const r = await api.release(date);
      data[date] = cleanDay(r.day);
      buzz(10);
      closeSheet();
      renderDays();
      renderRoom();
      toast('Парту звільнено');
    } catch {
      $('sheet-error').textContent = 'Не вдалося звільнити парту. Спробуй ще раз.';
    } finally {
      $('sheet-release').disabled = false;
    }
  });
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
  function renderPolls() {
    const box = $('polls');
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
      if (p.own) {
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
    } catch {
      toast('Не вдалося проголосувати. Спробуй ще раз.');
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
      err(e2.code === 'limit' ? 'Можна мати до 3 опитувань одночасно. Видали старе.' : 'Не вдалося створити. Перевір інтернет і спробуй ще раз.');
    } finally {
      $('poll-save').disabled = false;
    }
  });

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
    const box = $('week');
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

      const L = C.week[i], { first, last, count } = span(L);
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
          const item = hw[hwKey(date, n)];
          if (item) body.append(h('div', 'hw-text', item.text));
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
    const box = $('bells');
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
  const TABS = ['desks', 'week', 'hw', 'polls'];
  function showView(view) {
    for (const b of document.querySelectorAll('.seg-ctl button')) b.setAttribute('aria-checked', String(b.dataset.view === view));
    $('view-lessons').hidden = view !== 'lessons';
    $('view-bells').hidden = view !== 'bells';
    store.set('view', view);
  }
  document.querySelectorAll('.seg-ctl button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  function showTab(name) {
    // дзвінки тепер усередині «Розкладу»
    if (name === 'bells') { showView('bells'); name = 'week'; }
    if (!TABS.includes(name)) name = 'desks';
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
      $(`panel-${t}`).hidden = t !== name;
    }
    store.set('tab', name);
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
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
    const i = bookDates.indexOf(selDate) + dir;
    if (i < 0 || i >= bookDates.length) return;
    selDate = bookDates[i];
    renderDays();
    renderRoom();
    slide($('room'), dir);
  });
  onSwipe($('week'), dir => {
    if (innerWidth >= 900) return;
    const now = kyivNow(), dates = weekDates(now), i = dates.indexOf(weekSel) + dir;
    if (i < 0 || i >= dates.length) return;
    weekSel = dates[i];
    renderWeek(now, status(now));
    slide($('week'), dir);
  });

  // ---------- тема і посилання ----------
  const THEMES = { auto: 'як у телефоні', light: 'світла', dark: 'темна' };
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'auto') delete root.dataset.theme;
    else root.dataset.theme = mode;
    $('theme').dataset.mode = mode;
    $('theme').setAttribute('aria-label', `Тема: ${THEMES[mode]}`);
    const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.content = mode === 'auto' ? (m.media.includes('dark') ? '#16201c' : '#f5f8fc') : paper;
    }
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
  $('strip').addEventListener('click', () => {
    showTab('week');
    document.querySelector('.tabs').scrollIntoView({ behavior: 'smooth' });
  });

  // ---------- старт ----------
  document.documentElement.classList.add('intro');
  applyTheme(store.get('theme', 'auto'));
  $('year').textContent = C.year;
  $('rules').append(...C.rules.map(r => h('li', '', r)));
  showView(store.get('view', 'lessons'));
  showTab(location.hash.slice(1) || store.get('tab', 'desks'));
  tick();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && api === server) refresh(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // офлайн і встановлення на телефон (sw.js); у вбудованому перегляді просто не спрацює
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
