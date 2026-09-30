// Cloudflare Worker: reads public Telegram channel pages (t.me/s/<channel>) on request and returns
// the air-raid state plus course / hit / air-defence reports for Zhytomyr as JSON.
// Settings (Cloudflare -> Worker -> Settings -> Variables): CHANNELS, PLACES, HOURS.

export const DEFAULT_PLACES = 'Житомир,Бердич,Корост,Новоград-Волин,Звягел,Малин,Овруч,Радомишл,Баранівк,Андрушівк,Попільн,Чуднів,Черняхів,Брусилів,Ружин,Емільчин,Лугин,Полісс';

const PVO = /ппо|пво|збит|збили|знищен|працює\s+пво|працювала\s+пво|мобільн\w+\s+груп/i;
const HIT = /приліт|прилет|влучан|вибух|вибух|удар|уражен|пошкодж|руйнуван|пожеж|загинул|постражда/i;
const COURSE = /шахед|шахєд|бпла|дрон|ракет|курс|напрям|крилат|балістик|герань|гербера|калібр/i;

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

// -> 'alert_on' | 'alert_off' | 'pvo' | 'hit' | 'course' | null
export function classify(text, places) {
  const low = text.toLowerCase();
  if (!places.some(p => low.includes(p))) return null;
  if (/відбій/i.test(text)) return 'alert_off';
  if (/повітряна\s+тривога/i.test(text)) return 'alert_on';
  if (PVO.test(text)) return 'pvo';
  if (HIT.test(text)) return 'hit';
  if (COURSE.test(text)) return 'course';
  return null;
}

export default {
  async fetch(req, env) {
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=15' };
    const sources = (env.CHANNELS || '').split(',').map(s => s.trim().replace(/^@|^https?:\/\/t\.me\/(s\/)?/, '')).filter(Boolean);
    const places = (env.PLACES || DEFAULT_PLACES).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const since = Date.now() - (+env.HOURS || 24) * 3600e3;
    const events = [];
    let alert = null;
    await Promise.all(sources.map(async src => {
      const channel = src.split('?')[0];
      try {
        const res = await fetch(`https://t.me/s/${src}`, { cf: { cacheTtl: 15 }, headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!res.ok) return;
        for (const m of parseMessages(await res.text())) {
          const type = classify(m.text, places);
          if (!type) continue;
          const url = `https://t.me/${m.post}`;
          if (type.startsWith('alert_')) {
            if (!alert || m.ts > alert.ts) alert = { ts: m.ts, state: type === 'alert_on' ? 'on' : 'off', channel, url, text: m.text.slice(0, 200) };
          } else if (m.ts >= since) {
            events.push({ type, time: new Date(m.ts).toISOString(), channel, url, text: m.text.slice(0, 400) });
          }
        }
      } catch {}
    }));
    events.sort((a, b) => b.time.localeCompare(a.time));
    if (alert) alert.since = new Date(alert.ts).toISOString();
    return new Response(JSON.stringify({ updated: new Date().toISOString(), alert, events }), { headers });
  }
};
