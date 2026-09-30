import assert from 'node:assert';
import { parseMessages, classify, alertState, relevantText, DEFAULT_PLACES } from './index.js';
const places = DEFAULT_PLACES.split(',').map(s => s.toLowerCase());
const msg = (post, t, text) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="${post}"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><a class="tgme_widget_message_date"><time datetime="${t}" class="time">x</time></a></div></div>`;
const m = parseMessages(msg('a/1', '2026-09-30T17:00:00+00:00', '🔴 Повітряна тривога в Житомирська область<br/>#Житомирська_область') + msg('a/2', '2026-09-30T17:30:00+00:00', '🟢 Відбій тривоги в Житомирська область'));
assert.equal(m.length, 2); assert.equal(m[0].post, 'a/1'); assert.equal(m[1].ts, Date.parse('2026-09-30T17:30:00Z'));

// alert bot
assert.equal(alertState(m[0].text, places, false), 'on'); assert.equal(alertState(m[1].text, places, false), 'off');
assert.equal(alertState('Повітряна тривога в Київська область', places, false), null);
// local channel alert posts
assert.equal(alertState('🔴 Повітряна тривога!', places, true), 'on');
assert.equal(alertState('🟢 Відбій тривоги', places, true), 'off');
assert.equal(alertState('Реактивний БпЛА в бік Радомишля! До відбою в укриттях', places, true), null);

// country-wide monitor: keep only our lines, signature does not count as air defence
const mon = relevantText('📡Реактивні шахеди:\n⚠️2 реактивні шахеди з Чернігівщини на Київщину; ⚠️1 реактивний шахед з Київщини на Житомирщину\nПідписатись 👉 🚀ППО | РАДАР @mon1tor_ua', places, false);
assert.equal(mon, '⚠️1 реактивний шахед з Київщини на Житомирщину'); assert.equal(classify(mon, false), 'course');
assert.equal(classify(relevantText('2 на півночі Київщини на Житомирщину', places, false), false), 'course');
assert.equal(relevantText('Шахеди на Київ', places, false), '');

// local channel
const t = relevantText('Попередньо, збили. Дякуємо силам ППО.\nТруха⚡️Житомир | Надіслати новину', places, true);
assert.equal(t, 'Попередньо, збили. Дякуємо силам ППО.'); assert.equal(classify(t, true), 'pvo');
assert.equal(classify('Вибухи! Сидимо в укриттях.', true), 'hit');
assert.equal(classify('Реактивний БпЛА в бік Радомишля!', true), 'course');
assert.equal(classify('8800 дерев — 33 млн грн збитків: на Житомирщині викрили лісорубів', true), null);
assert.equal(classify('Ударні БпЛА курсом на Житомир', true), 'course');
console.log('ok');
