// Writes dashboard/events.json from the Telegram channels. District states and their 48-hour history carry over
// between runs. The file is rewritten at most every 6 minutes: GitHub Pages builds a branch about 10 times an hour
// before queueing, and the live feed comes from the Cloudflare Worker anyway.
import { readFileSync, writeFileSync } from 'node:fs';
import { collect } from '../worker/index.js';

const file = 'dashboard/events.json';
const MIN_GAP = 6 * 60e3;
let prev = {};
try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
// 8 days of alert history: the dashboard's weekly statistics are built from it.
const d = await collect({ ...process.env, PAGES_LOCAL: process.env.PAGES_LOCAL || 2, HISTORY_HOURS: process.env.HISTORY_HOURS || 192 }, prev.districts);
for (const e of d.errors) console.error('warn:', e);
const key = x => JSON.stringify([x.districts, x.events]);
const changed = key(prev) !== key(d);
const due = !prev.updated || Date.now() - Date.parse(prev.updated) >= MIN_GAP;
if (changed && due) writeFileSync(file, JSON.stringify(d) + '\n');
console.log(`city=${d.alert?.state ?? 'unknown'} events=${d.events.length} ${changed ? (due ? 'written' : 'changed, waiting') : 'unchanged'}`);
