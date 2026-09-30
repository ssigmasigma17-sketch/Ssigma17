// Dev tool: saves recent posts of every channel (several pages) to corpus/, so the parser can be checked
// against real wording. Run via the "Corpus" workflow (manual).
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseMessages, DEFAULT_CHANNELS } from '../worker/index.js';

const PAGES = +process.env.PAGES || 4;
const UA = { 'user-agent': 'Mozilla/5.0 (zhytomyr-dashboard)' };
mkdirSync('corpus', { recursive: true });

const channels = {};
for (const src of DEFAULT_CHANNELS.split(',')) {
  const [name, query] = src.split('?');
  let before = '', all = [];
  for (let p = 0; p < PAGES; p++) {
    const url = `https://t.me/s/${name}?${[query, before && `before=${before}`].filter(Boolean).join('&')}`;
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) { console.error(name, res.status); break; }
      const ms = parseMessages(await res.text());
      if (!ms.length) break;
      all = [...ms, ...all];
      before = ms[0].post.split('/')[1];
    } catch (e) { console.error(name, e.message); break; }
  }
  const seen = new Set();
  channels[name] = all.filter(m => !seen.has(m.post) && seen.add(m.post)).map(m => ({ post: m.post, time: new Date(m.ts).toISOString(), text: m.text }));
  console.log(name, channels[name].length);
}
writeFileSync('corpus/messages.json', JSON.stringify(channels, null, 1));
