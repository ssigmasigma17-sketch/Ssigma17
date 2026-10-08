# Сервер 8-Б

Зберігає броні парт і домашку для сайту https://ssigmasigma17-sketch.github.io/Ssigma17/8b/
(Cloudflare Worker + Durable Object з SQLite, безкоштовний тариф).

## Запуск на Cloudflare

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Import a repository** → `Ssigma17`.
2. У налаштуваннях збірки вказати кореневу папку (**Root directory / Path**): `8b-worker`. Решту не чіпати.
3. **Deploy**. Адреса буде `https://class-8b.<твій-субдомен>.workers.dev`.
4. Вписати цю адресу в `8b/data.js` на гілці `gh-pages`: `api: 'https://class-8b.….workers.dev'`.

API — див. коментар на початку `worker.js`. Ім’я Worker у Cloudflare має збігатися з `name` у `wrangler.toml` (`class-8b`).
