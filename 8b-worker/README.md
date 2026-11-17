# Сервер 8-Б

Зберігає броні парт і домашку для сайту https://ssigmasigma17-sketch.github.io/Ssigma17/8b/
(Cloudflare Worker + Durable Object з SQLite, безкоштовний тариф).

## Запуск на Cloudflare

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Import a repository** → `Ssigma17`.
2. У налаштуваннях збірки вказати кореневу папку (**Root directory / Path**): `8b-worker`. Решту не чіпати.
3. **Deploy**. Адреса буде `https://class-8b.<твій-субдомен>.workers.dev`.
4. Вписати цю адресу в `8b/data.js` на гілці `gh-pages`: `api: 'https://class-8b.….workers.dev'`.

API — див. коментар на початку `worker.js`. Ім’я Worker у Cloudflare має збігатися з `name` у `wrangler.toml` (`class-8b`).

## Telegram-бот (`bot.js`)

1. @BotFather → `/newbot` → отримати токен.
2. Cloudflare → Workers & Pages → `class-8b` → Settings → Variables and Secrets → Add → Secret, імʼя `TG_TOKEN`.
3. На сайті в режимі старости (5 торкань по «8-Б») → «Підключити Telegram-бота».

Команди: /now, /today, /tomorrow, /hw, /bells, /subscribe (нагадування о 7:00 і 19:00), /unsubscribe.
Розклад бот читає з `8b/schedule.json` на сайті. Після змін у `8b/data.js` онови його (з папки `8b` у гілці gh-pages):

    node -e "const vm=require('vm'),fs=require('fs');const c={window:{}};vm.createContext(c);vm.runInContext(fs.readFileSync('data.js','utf8'),c);const C=c.window.CLASS;fs.writeFileSync('schedule.json',JSON.stringify({name:C.name,year:C.year,altStart:C.altStart,bells:C.bells,breakNotes:C.breakNotes,week:C.week}))"
