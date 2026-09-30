// Reads public Telegram channel pages (t.me/s/<channel>) and returns the Zhytomyr air-raid state plus
// course / hit / air-defence reports. Used by scripts/collect.mjs (GitHub Actions) and as a Cloudflare Worker.
// Optional settings: CHANNELS, ALERT_CHANNELS, PLACES, HOURS (comma-separated).

export const DEFAULT_CHANNELS = 'air_alert_ua?q=%23Житомирська_область,Angry_Pol,blacklist_public,truexazhitomir,pzhytomyr,PpoUARadar,mon1tor_ua,eRadarrua,deraketaua,monitor_ukr';
export const DEFAULT_PLACES = 'Житомир,Бердич,Корост,Новоград-Волин,Звягел,Малин,Овруч,Радомишл,Баранівк,Андрушівк,Попільн,Чуднів,Черняхів,Брусилів,Ружин,Емільчин,Лугин,Полісс';

const PVO = /ппо|пво|збит|збили|знищен|мобільн\w+\s+груп/i;
const HIT = /приліт|прилет|влучан|вибух|удар|уражен|пошкодж|руйнуван|пожеж|загинул|постражда/i;
const COURSE = /шахед|шахєд|бпла|дрон|ракет|курс|напрям|крилат|балістик|герань|гербера|калібр/i;
const OBLAST = /житомирськ\S*\s+област/i;

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

// Alert-bot message -> 'on' | 'off' | null
export function alertState(text, places) {
  if (!mentions(text, places)) return null;
  if (/відбій/i.test(text)) return 'off';
  if (/тривог/i.test(text)) return 'on';
  return null;
}

// News / monitoring message -> 'pvo' | 'hit' | 'course' | null
export function classify(text, places) {
  if (!mentions(text, places)) return null;
  if (PVO.test(text)) return 'pvo';
  if (HIT.test(text)) return 'hit';
  if (COURSE.test(text)) return 'course';
  return null;
}

export async function collect(env = {}) {
  const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const sources = list(env.CHANNELS || DEFAULT_CHANNELS).map(s => s.replace(/^@|^https?:\/\/t\.me\/(s\/)?/, ''));
  const alertChannels = list(env.ALERT_CHANNELS || 'air_alert_ua').map(s => s.toLowerCase());
  const places = list(env.PLACES || DEFAULT_PLACES).map(s => s.toLowerCase());
  const since = Date.now() - (+env.HOURS || 24) * 3600e3;
  const events = [], alerts = [], errors = [];
  await Promise.all(sources.map(async src => {
    const channel = src.split('?')[0];
    try {
      const res = await fetch(`https://t.me/s/${src}`, { headers: { 'user-agent': 'Mozilla/5.0 (zhytomyr-dashboard)' } });
      if (!res.ok) { errors.push(`${channel}: HTTP ${res.status}`); return; }
      const messages = parseMessages(await res.text());
      if (!messages.length) errors.push(`${channel}: no messages on page`);
      for (const m of messages) {
        const url = `https://t.me/${m.post}`;
        if (alertChannels.includes(channel.toLowerCase())) {
          const state = alertState(m.text, places);
          if (state) alerts.push({ ts: m.ts, state, oblast: OBLAST.test(m.text), channel, url, text: m.text.slice(0, 200) });
          continue;
        }
        const type = classify(m.text, places);
        if (type && m.ts >= since) events.push({ type, time: new Date(m.ts).toISOString(), channel, url, text: m.text.slice(0, 500) });
      }
    } catch (e) { errors.push(`${channel}: ${e.message}`); }
  }));
  // Whole-oblast messages decide the state; district-only ones are used only when nothing else exists.
  const pool = alerts.some(a => a.oblast) ? alerts.filter(a => a.oblast) : alerts;
  const last = pool.sort((a, b) => b.ts - a.ts)[0];
  const seen = new Set();
  return {
    updated: new Date().toISOString(),
    alert: last ? { state: last.state, since: new Date(last.ts).toISOString(), channel: last.channel, url: last.url, text: last.text } : null,
    events: events.filter(e => !seen.has(e.url) && seen.add(e.url)).sort((a, b) => b.time.localeCompare(a.time)),
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
