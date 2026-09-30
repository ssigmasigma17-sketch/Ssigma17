// Cloudflare Worker: reads public Telegram channel pages on request and returns Zhytomyr hit / air-defence reports as JSON.
// Settings (Cloudflare dashboard -> Worker -> Settings -> Variables): CHANNELS="chan1,chan2", optional PLACES, HOURS.
const HIT = /приліт|прилет|влучан|вибух|удар|уражен|пошкодж|руйнуван|пожеж|загинул|постражда/i;
const PVO = /ппо|пво|збит|збили|знищен|працює\s+пво|працювала\s+пво|мобільн\w+\s+груп/i;
const PLACES = 'Житомир,Житомирщин,Житомирськ,Коростень,Бердичів,Новоград-Волинськ,Звягел,Малин,Овруч,Радомишль,Баранівк,Коростишів,Андрушівк,Попільн,Чуднів';

const decode = s => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

export default {
  async fetch(req, env) {
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=20' };
    const channels = (env.CHANNELS || '').split(',').map(s => s.trim().replace(/^@|^https?:\/\/t\.me\/(s\/)?/, '')).filter(Boolean);
    const places = (env.PLACES || PLACES).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const since = Date.now() - (+env.HOURS || 24) * 3600e3;
    const events = [];
    await Promise.all(channels.map(async ch => {
      try {
        const res = await fetch(`https://t.me/s/${ch}`, { cf: { cacheTtl: 20 }, headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!res.ok) return;
        for (const block of (await res.text()).split('tgme_widget_message_wrap').slice(1)) {
          const post = /data-post="([^"]+)"/.exec(block)?.[1];
          const time = /<time[^>]*datetime="([^"]+)"/.exec(block)?.[1];
          const body = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
          if (!post || !time || !body) continue;
          const ts = Date.parse(time);
          if (!(ts >= since)) continue;
          const text = decode(body);
          const low = text.toLowerCase();
          if (!places.some(p => low.includes(p))) continue;
          const type = PVO.test(text) ? 'pvo' : HIT.test(text) ? 'hit' : null;
          if (type) events.push({ type, time: new Date(ts).toISOString(), channel: ch, url: `https://t.me/${post}`, text: text.slice(0, 400) });
        }
      } catch {}
    }));
    events.sort((a, b) => b.time.localeCompare(a.time));
    return new Response(JSON.stringify({ updated: new Date().toISOString(), events }), { headers: cors });
  }
};
