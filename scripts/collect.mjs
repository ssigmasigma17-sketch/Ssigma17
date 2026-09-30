// Writes dashboard/events.json from the Telegram channels; rewrites the file only when the content changed.
// District alert states are carried over between runs, since channel pages show only recent posts.
import { readFileSync, writeFileSync } from 'node:fs';
import { collect } from '../worker/index.js';

const file = 'dashboard/events.json';
let prev = {};
try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
const d = await collect(process.env, prev.districts);
for (const e of d.errors) console.error('warn:', e);
const key = x => JSON.stringify([x.districts, x.events]);
const changed = key(prev) !== key(d);
if (changed) writeFileSync(file, JSON.stringify(d, null, 1) + '\n');
console.log(`${d.district}=${d.alert?.state ?? 'unknown'} events=${d.events.length} ${changed ? 'written' : 'unchanged'}`);
