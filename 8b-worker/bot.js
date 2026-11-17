// Telegram-бот класу 8-Б. Живе в тому самому Worker: Telegram надсилає повідомлення на /tg (вебхук),
// а вранці й увечері cron розсилає нагадування в підписані чати.
// Токен бота — секрет TG_TOKEN у Cloudflare. Розклад бот бере з schedule.json на сайті.
// Для перевірки без справжнього Telegram: TG_API підміняє адресу Telegram API, SCHEDULE_URL — адресу розкладу,
// TG_TEST_HOUR — годину для нагадувань.

const SITE = 'https://ssigmasigma17-sketch.github.io/Ssigma17/8b/';
const SCHEDULE_URL = SITE + 'schedule.json';
const MAX_CHATS = 30;

const COMMANDS = [
  ['now', 'Що зараз і скільки до дзвінка'],
  ['today', 'Уроки сьогодні'],
  ['tomorrow', 'Уроки й домашка на завтра'],
  ['hw', 'Домашка на найближчий день'],
  ['bells', 'Розклад дзвінків'],
  ['subscribe', 'Нагадування в цей чат о 7:00 і 19:00'],
  ['unsubscribe', 'Вимкнути нагадування'],
  ['help', 'Що вміє бот'],
];

// ---------- розклад ----------
let cached = null;
async function schedule(env) {
  if (cached && Date.now() - cached.at < 10 * 60e3) return cached.data;
  const r = await fetch(env.SCHEDULE_URL || SCHEDULE_URL, { cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`schedule ${r.status}`);
  cached = { at: Date.now(), data: await r.json() };
  return cached.data;
}

const DOW = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const KYIV = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function kyivNow() {
  const p = Object.fromEntries(KYIV.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, min: +p.hour * 60 + +p.minute };
}
const utc = d => Date.parse(d + 'T00:00:00Z');
const dowOf = d => new Date(utc(d)).getUTCDay();
const addDays = (d, n) => new Date(utc(d) + n * 864e5).toISOString().slice(0, 10);
const longDate = d => `${DOW[dowOf(d)]}, ${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmt = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// уроки дня з урахуванням предметів, що чергуються по тижнях
function lessonsOn(C, date) {
  const dow = dowOf(date);
  if (dow < 1 || dow > 5) return null;
  const week = ((Math.floor((utc(date) - utc(C.altStart)) / 864e5 / 7) % 2) + 2) % 2;
  return C.week[dow - 1].map(l => (l && l.alt ? l.alt[week] : l));
}
function nextSchoolDay(C, date) {
  let d = addDays(date, 1);
  while (!lessonsOn(C, d)) d = addDays(d, 1);
  return d;
}
const subj = l => l.s || l.g.map(g => g.s).join(' / ');
const room = l => l.r || [...new Set(l.g.map(g => g.r))].join(' / ');

function dayText(C, date, hw, title) {
  const L = lessonsOn(C, date);
  if (!L) return `<b>${esc(title)}</b>\nУроків немає.`;
  const lines = [`<b>${esc(title)}</b> — ${esc(longDate(date))}`];
  L.forEach((l, i) => {
    if (!l) return;
    const [a] = C.bells[i];
    lines.push(`${i + 1}. ${a} · <b>${esc(subj(l))}</b> · каб. ${esc(room(l))}`);
    const h = hw[`${date}|${i + 1}`];
    if (h) lines.push(`   ✏️ ${esc(h.text)}`);
  });
  return lines.join('\n');
}

function nowText(C) {
  const now = kyivNow(), L = lessonsOn(C, now.date), B = C.bells.map(([a, b]) => [toMin(a), toMin(b)]);
  if (L) {
    const idx = L.map((l, i) => (l ? i : -1)).filter(i => i >= 0), first = idx[0], last = idx[idx.length - 1];
    if (now.min < B[first][0]) return `До першого уроку ${B[first][0] - now.min} хв.\n${first + 1} урок о ${fmt(B[first][0])} — <b>${esc(subj(L[first]))}</b>, каб. ${esc(room(L[first]))}.`;
    for (const i of idx) {
      const [a, b] = B[i];
      if (now.min >= a && now.min < b) {
        const next = idx.find(j => j > i);
        return `Зараз ${i + 1} урок — <b>${esc(subj(L[i]))}</b>, каб. ${esc(room(L[i]))}.\nДо дзвінка ${b - now.min} хв.` +
          (next != null ? `\nДалі: ${esc(subj(L[next]))}, каб. ${esc(room(L[next]))}.` : '\nЦе останній урок.');
      }
      const next = idx.find(j => j > i);
      if (next != null && now.min >= b && now.min < B[next][0]) {
        return `Перерва, до дзвінка ${B[next][0] - now.min} хв.\nДалі ${next + 1} урок — <b>${esc(subj(L[next]))}</b>, каб. ${esc(room(L[next]))}.`;
      }
    }
  }
  const nd = nextSchoolDay(C, now.date), NL = lessonsOn(C, nd), f = NL.findIndex(Boolean);
  return `${L ? 'Уроки закінчились' : 'Сьогодні вихідний'}.\nНаступний навчальний день — ${esc(longDate(nd))}, перший урок о ${C.bells[f][0]}: <b>${esc(subj(NL[f]))}</b>.`;
}

function bellsText(C) {
  const used = Math.max(...C.week.map(L => L.reduce((m, l, i) => (l ? i : m), 0))) + 1;
  return ['<b>Дзвінки</b>', ...C.bells.slice(0, used).map(([a, b], i) => `${i + 1}. ${a}–${b}`)].join('\n');
}

const HELP = `Я бот класу 8-Б.\n\n${COMMANDS.map(([c, d]) => `/${c} — ${d}`).join('\n')}\n\nПарти, домашка й чат — на сайті.`;

// ---------- Telegram ----------
export async function tgSecret(env) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.TG_TOKEN}:8b-webhook`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}
async function tg(env, method, body) {
  const base = env.TG_API || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false, error_code: r.status }));
}
const siteButton = { reply_markup: { inline_keyboard: [[{ text: 'Відкрити сайт 8-Б', url: SITE }]] } };
const send = (env, chat, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// Підключення бота: вебхук на цей Worker, захищений секретом, і меню команд. Викликає староста з сайту.
export async function tgSetup(env, origin) {
  if (!env.TG_TOKEN) return { error: 'no_token' };
  const me = await tg(env, 'getMe', {});
  if (!me.ok) return { error: 'bad_token' };
  const hook = await tg(env, 'setWebhook', {
    url: `${origin}/tg`, secret_token: await tgSecret(env), allowed_updates: ['message'], drop_pending_updates: true,
  });
  if (!hook.ok) return { error: 'webhook' };
  await tg(env, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  return { ok: true, username: me.result.username };
}

// Повідомлення від Telegram
export async function handleTg(request, env, board) {
  if (!env.TG_TOKEN || request.headers.get('x-telegram-bot-api-secret-token') !== (await tgSecret(env))) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => ({}));
  const m = update.message;
  if (!m?.text || !m.text.startsWith('/')) return new Response('ok');
  const cmd = m.text.trim().split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
  const chat = m.chat.id;
  try {
    const C = await schedule(env), now = kyivNow();
    switch (cmd) {
      case 'start':
      case 'help':
        await send(env, chat, HELP, siteButton);
        break;
      case 'now':
        await send(env, chat, nowText(C));
        break;
      case 'today':
        await send(env, chat, dayText(C, now.date, await board.hw(now.date, now.date), 'Сьогодні'));
        break;
      case 'tomorrow': {
        const d = nextSchoolDay(C, now.date);
        await send(env, chat, dayText(C, d, await board.hw(d, d), d === addDays(now.date, 1) ? 'Завтра' : 'Наступний навчальний день'), siteButton);
        break;
      }
      case 'hw': {
        // найближчий день, на який ще варто робити домашку: сьогодні до кінця уроків, інакше наступний
        const L = lessonsOn(C, now.date), lastEnd = L ? toMin(C.bells[L.reduce((m, l, i) => (l ? i : m), 0)][1]) : 0;
        const d = L && now.min < lastEnd ? now.date : nextSchoolDay(C, now.date);
        const hw = await board.hw(d, d), items = Object.entries(hw);
        const LL = lessonsOn(C, d);
        const text = items.length
          ? [`<b>Домашка</b> — ${esc(longDate(d))}`, ...items.sort().map(([k, v]) => `${esc(subj(LL[+k.split('|')[1] - 1] || { s: 'Урок ' + k.split('|')[1] }))}: ${esc(v.text)}`)].join('\n')
          : `На ${esc(longDate(d))} домашки ще ніхто не записав.`;
        await send(env, chat, text, siteButton);
        break;
      }
      case 'bells':
        await send(env, chat, bellsText(C));
        break;
      case 'subscribe': {
        const r = await board.tgSubscribe(chat, m.chat.title || m.chat.first_name || '', MAX_CHATS);
        await send(env, chat, r.error ? 'Забагато чатів уже підписано.' : 'Готово: щодня о 7:00 надсилатиму уроки на сьогодні, а о 19:00 — уроки й домашку на завтра. Вимкнути — /unsubscribe');
        break;
      }
      case 'unsubscribe':
        await board.tgUnsubscribe(chat);
        await send(env, chat, 'Нагадування вимкнено.');
        break;
      default:
        if (m.chat.type === 'private') await send(env, chat, HELP, siteButton);
    }
  } catch (e) {
    await send(env, chat, 'Щось пішло не так, спробуй трохи пізніше.');
  }
  return new Response('ok');
}

// Нагадування: cron запускається двічі (взимку й улітку різниця з UTC різна), а надсилаємо лише о 7:00 чи 19:00 за Києвом.
export async function tgDaily(env, board) {
  if (!env.TG_TOKEN) return;
  const now = kyivNow(), hour = env.TG_TEST_HOUR ? +env.TG_TEST_HOUR : now.hour;
  if (hour !== 7 && hour !== 19) return;
  const C = await schedule(env);
  let text;
  if (hour === 7) {
    if (!lessonsOn(C, now.date)) return;
    text = dayText(C, now.date, await board.hw(now.date, now.date), 'Доброго ранку! Сьогодні');
  } else {
    const d = addDays(now.date, 1);
    if (!lessonsOn(C, d)) return;
    text = dayText(C, d, await board.hw(d, d), 'На завтра');
  }
  for (const chat of await board.tgChats()) {
    const r = await send(env, chat, text);
    // бота видалили з чату або заблокували — більше туди не пишемо
    if (r.error_code === 403) await board.tgUnsubscribe(chat);
  }
}
