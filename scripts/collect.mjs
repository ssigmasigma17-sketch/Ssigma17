// Writes dashboard/events.json from the Telegram channels; rewrites the file only when the content changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { collect } from '../worker/index.js';

const file = 'dashboard/events.json';
const d = await collect(process.env);
for (const e of d.errors) console.error('warn:', e);
let prev = {};
try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
// Channel pages show only recent posts, so keep the last known state when the newest one scrolled out of view.
if (prev.alert && (!d.alert || prev.alert.since > d.alert.since)) d.alert = prev.alert;
const key = x => JSON.stringify([x.alert, x.events]);
const changed = key(prev) !== key(d);
if (changed) writeFileSync(file, JSON.stringify(d, null, 1) + '\n');
console.log(`alert=${d.alert?.state ?? 'none'} events=${d.events.length} ${changed ? 'written' : 'unchanged'}`);
