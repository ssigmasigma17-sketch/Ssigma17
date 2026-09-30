// Writes dashboard/events.json from the Telegram channels; rewrites the file only when the content changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { collect } from '../worker/index.js';

const file = 'dashboard/events.json';
const d = await collect(process.env);
for (const e of d.errors) console.error('warn:', e);
let prev = {};
try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
const key = x => JSON.stringify([x.alert, x.events]);
const changed = key(prev) !== key(d);
if (changed) writeFileSync(file, JSON.stringify(d, null, 1) + '\n');
console.log(`alert=${d.alert?.state ?? 'none'} events=${d.events.length} ${changed ? 'written' : 'unchanged'}`);
