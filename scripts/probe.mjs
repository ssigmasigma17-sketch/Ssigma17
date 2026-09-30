// Temporary: shows how channels word alert / all-clear posts.
import { parseMessages } from '../worker/index.js';
const out = {};
for (const ch of ['Angry_Pol', 'blacklist_public', 'truexazhitomir', 'pzhytomyr', 'air_alert_ua', 'PpoUARadar']) {
  try {
    const html = await (await fetch(`https://t.me/s/${ch}`, { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
    const ms = parseMessages(html);
    out[ch] = { newest: ms.at(-1)?.ts && new Date(ms.at(-1).ts).toISOString(), alerts: ms.filter(m => /тривог|відбій|загроз|рівень/i.test(m.text)).slice(-8).map(m => new Date(m.ts).toISOString().slice(11, 16) + ' ' + m.text.replace(/\s+/g, ' ').slice(0, 220)) };
  } catch (e) { out[ch] = e.message; }
}
export default out;
