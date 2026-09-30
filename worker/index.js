// Reads public Telegram channel pages (t.me/s/<channel>) and returns the Zhytomyr air-raid state plus
// course / hit / air-defence reports. Used by scripts/collect.mjs (GitHub Actions) and as a Cloudflare Worker.
// Optional settings: CHANNELS, ALERT_CHANNELS, PLACES, HOURS (comma-separated).

export const DEFAULT_CHANNELS = 'air_alert_ua,air_alert_ua?q=%23Житомирська_область,Angry_Pol,blacklist_public,truexazhitomir,pzhytomyr,PpoUARadar,mon1tor_ua,eRadarrua,deraketaua,monitor_ukr';
// Channels that write only about Zhytomyr: every message counts, and their alert / all-clear posts are used for the state.
export const DEFAULT_LOCAL = 'Angry_Pol,blacklist_public,truexazhitomir,pzhytomyr';
export const DEFAULT_PLACES = 'Житомир,Бердич,Корост,Новоград-Волин,Звягел,Малин,Овруч,Радомишл,Баранівк,Андрушівк,Попільн,Чуднів,Черняхів,Брусилів,Ружин,Емільчин,Лугин,Полісс';

const PVO = /працю\S*\s+ппо|ппо\s+працю|робот\S*\s+ппо|сил\S*\s+ппо|збит(?!к)|збили|знищен|мобільн\S*\s+(вогнев\S*\s+)?груп/i;
const HIT = /приліт|прилет|влучан|вибух|удар(?!н)|уражен|пошкодж|руйнуван|пожеж|загинул|постражда/i;
const COURSE = /шахед|шахєд|бпла|дрон|ракет|курс|напрям|крилат|балістик|герань|гербера|калібр|реактив/i;
const OBLAST = /житомирськ\S*\s+област/i;
const SIGNATURE = /надіслати новину|підписати|підписатись|підписуйтесь|@\w{4,}|t\.me\//i;
const LOCAL_ALERT = /^[^а-яіїєґa-z]*(повітряна тривога|тривога|відбій)/i;

const decode = s => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

export function parseMessages(html) {
  const out = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = /data-post="([^"]+)"/.exec(block)?.[1];
    const time = /<time[^>]*datetime="([^"]+)"/.exec(block)?.[1];
    const body = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
    if (post && time && body) out.push({ post, ts: Date.parse(time), text: decode(body) });
  }
  return out;
}

const mentions = (text, places) => { const low = text.toLowerCase(); return places.some(p => low.includes(p)); };

// Drops channel signatures; for country-wide channels keeps only the lines / items about our places.
export function relevantText(text, places, local) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(s => s && !SIGNATURE.test(s));
  if (local) return lines.join('\n');
  return lines.flatMap(l => l.split(/;\s*/)).filter(s => mentions(s, places)).join('\n');
}

// Alert message -> 'on' | 'off' | null. Alert-bot posts must name our area; local posts must start with the word.
export function alertState(text, places, local) {
  if (local ? !(text.length < 160 && LOCAL_ALERT.test(text)) : !mentions(text, places)) return null;
  if (/відбій/i.test(text)) return 'off';
  if (/тривог/i.test(text)) return 'on';
  return null;
}

// Relevant text -> 'pvo' | 'hit' | 'course' | null. Monitoring channels only post about targets, so they default to 'course'.
export function classify(text, local) {
  if (!text) return null;
  if (PVO.test(text)) return 'pvo';
  if (HIT.test(text)) return 'hit';
  if (COURSE.test(text) || !local) return 'course';
  return null;
}

export async function collect(env = {}) {
  const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const sources = list(env.CHANNELS || DEFAULT_CHANNELS).map(s => s.replace(/^@|^https?:\/\/t\.me\/(s\/)?/, ''));
  const alertChannels = list(env.ALERT_CHANNELS || 'air_alert_ua').map(s => s.toLowerCase());
  const localChannels = list(env.LOCAL_CHANNELS || DEFAULT_LOCAL).map(s => s.toLowerCase());
  const places = list(env.PLACES || DEFAULT_PLACES).map(s => s.toLowerCase());
  const since = Date.now() - (+env.HOURS || 24) * 3600e3;
  const events = [], alerts = [], errors = [];
  await Promise.all(sources.map(async src => {
    const channel = src.split('?')[0], id = channel.toLowerCase();
    const local = localChannels.includes(id);
    try {
      const res = await fetch(`https://t.me/s/${src}`, { headers: { 'user-agent': 'Mozilla/5.0 (zhytomyr-dashboard)' } });
      if (!res.ok) { errors.push(`${src}: HTTP ${res.status}`); return; }
      const messages = parseMessages(await res.text());
      if (!messages.length) errors.push(`${src}: no messages on page`);
      for (const m of messages) {
        const url = `https://t.me/${m.post}`;
        if (alertChannels.includes(id) || local) {
          const state = alertState(m.text, places, local && !alertChannels.includes(id));
          if (state) { alerts.push({ ts: m.ts, state, oblast: OBLAST.test(m.text), channel, url, text: m.text.slice(0, 200) }); continue; }
          if (!local) continue;
        }
        if (m.ts < since) continue;
        const text = relevantText(m.text, places, local);
        const type = classify(text, local);
        if (type) events.push({ type, time: new Date(m.ts).toISOString(), channel, url, text: text.slice(0, 500) });
      }
    } catch (e) { errors.push(`${src}: ${e.message}`); }
  }));
  // Whole-oblast messages decide the state when there are any; otherwise the newest district / local post does.
  const pool = alerts.some(a => a.oblast) ? alerts.filter(a => a.oblast) : alerts;
  const last = pool.sort((a, b) => b.ts - a.ts)[0];
  const seen = new Set();
  return {
    updated: new Date().toISOString(),
    alert: last ? { state: last.state, since: new Date(last.ts).toISOString(), channel: last.channel, url: last.url, text: last.text } : null,
    events: events.sort((a, b) => b.time.localeCompare(a.time)).filter(e => {
      const k = e.text.replace(/\s+/g, ' ').toLowerCase();
      return !seen.has(k) && seen.add(k);
    }),
    errors,
  };
}

export default {
  async fetch(req, env) {
    return new Response(JSON.stringify(await collect(env)), {
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=15' },
    });
  },
};
