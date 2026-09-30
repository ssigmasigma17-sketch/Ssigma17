// Collects hit / air-defence reports about Zhytomyr region from public Telegram channel pages (t.me/s/<channel>).
// Runs in GitHub Actions; writes dashboard/events.json. Needs Node 20+, no dependencies.
import { readFileSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('dashboard/sources.json', 'utf8'));
const since = Date.now() - cfg.hours * 3600e3;
const HIT = /приліт|прилет|влучан|вибух|вибух|удар|уражен|пошкодж|руйнуван|пожеж|загинул|постражда/i;
const PVO = /ппо|пво|збит|збили|знищен|працює\s+пво|працювала\s+пво|мобільн\w+\s+груп|сил\w+\s+оборон\w+\s+працю/i;

const decode = s => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

const events = [];
for (const ch of cfg.channels) {
  try {
    const res = await fetch(`https://t.me/s/${ch}`, { headers: { 'user-agent': 'Mozilla/5.0 zhytomyr-dashboard' } });
    if (!res.ok) { console.error(ch, res.status); continue; }
    const html = await res.text();
    for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
      const post = /data-post="([^"]+)"/.exec(block)?.[1];
      const time = /<time[^>]*datetime="([^"]+)"/.exec(block)?.[1];
      const body = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
      if (!post || !time || !body) continue;
      const ts = Date.parse(time);
      if (!(ts >= since)) continue;
      const text = decode(body);
      if (!cfg.places.some(p => text.toLowerCase().includes(p.toLowerCase()))) continue;
      const type = PVO.test(text) ? 'pvo' : HIT.test(text) ? 'hit' : null;
      if (!type) continue;
      events.push({ type, time: new Date(ts).toISOString(), channel: ch, url: `https://t.me/${post}`, text: text.slice(0, 400) });
    }
  } catch (e) { console.error(ch, e.message); }
}
events.sort((a, b) => b.time.localeCompare(a.time));
const prev = (() => { try { return JSON.parse(readFileSync('dashboard/events.json', 'utf8')); } catch { return {}; } })();
if (JSON.stringify(prev.events) !== JSON.stringify(events)) {
  writeFileSync('dashboard/events.json', JSON.stringify({ updated: new Date().toISOString(), events }, null, 1));
}
console.log(`events: ${events.length}`);
