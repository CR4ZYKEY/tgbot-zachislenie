# Перенос бота на Railway и передача техническому отделу

Бот «Зачисление в школу» (ЦПСО / EdPalm). Сейчас (октябрь 2026) он **боевой** и работает
на рабочем компьютере. В базе уже живые родители, поэтому переносим вместе с данными.

## Что это за система

| Часть | Что делает | Команда запуска |
|---|---|---|
| **bot** | диалоги с родителями, long polling Telegram | `npm run start:prod` |
| **worker** | напоминания (тик раз в минуту) и синхронизация с Google-таблицей | `npm run worker:prod` |
| **PostgreSQL 16** | всё состояние: родители, ответы, очередь напоминаний | — |

- Стек: Node.js 22, TypeScript, NestJS, grammY, Prisma.
- Тексты, кнопки и сроки — только в `scenario/*.yaml` и `scenario/tariffs/*.yaml`. Картинки и PDF —
  в `assets/`. После правки YAML: `npm run scenario:check`.
- Входящих HTTP-портов нет: ни домен, ни healthcheck по порту не нужны.
- Правила проекта — `CLAUDE.md`, карта тарифов — `docs/Тарифы.md`, спецификация — `docs/spec.md`.

## Главное правило

**Один токен — один процесс bot и один процесс worker.** Если бот одновременно работает на
компьютере и на Railway, Telegram делит апдейты между ними и половина нажатий теряется.
Напоминания при этом уходят дважды. Поэтому:
- у каждого сервиса на Railway **Replicas = 1**;
- перед запуском на Railway локальный бот **останавливается** и больше не включается.

## 1. Код — в репозиторий технического отдела

Удалённого репозитория пока нет, история только локальная. Создать приватный репозиторий
(GitHub организации) и запушить ветку `master` с тегами:

```bash
git remote add origin <url репозитория>
git push -u origin master --tags
```

`.env` в git не попадает, так и должно быть. Секреты передаются отдельно (см. п. 4).

## 2. Railway: проект и база

1. New Project → **Deploy PostgreSQL**. Сервис базы назовите `Postgres`.
2. В Postgres → Variables скопируйте `DATABASE_PUBLIC_URL`: он нужен для переноса данных.

## 3. Перенос данных (простой бота 15–30 минут)

Делать строго в этом порядке. На компьютере с ботом:

1. Остановить локальные bot и worker (процессы `node … src/bot/main.ts` и `src/worker/main.ts`).
2. Снять дамп:
   ```bash
   "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U postgres -h localhost -Fc tgbot -f tgbot.dump
   ```
3. Залить в Railway:
   ```bash
   "C:\Program Files\PostgreSQL\16\bin\pg_restore.exe" --no-owner --no-acl -d "<DATABASE_PUBLIC_URL>" tgbot.dump
   ```
   В дампе есть таблица `_prisma_migrations`, поэтому `prisma migrate deploy` дальше ничего не
   повторит. Файл `tgbot.dump` содержит персональные данные: после переноса удалить.

Напоминания, срок которых наступил во время простоя, worker дошлёт сам после запуска,
в окне 10:00–21:00 МСК.

## 4. Railway: два сервиса из одного репозитория

New → GitHub Repo → этот репозиторий. Сделать **дважды**: сервисы `bot` и `worker`.

| Настройка | bot | worker |
|---|---|---|
| Build Command | `npm run scenario:check && npm run build` | `npm run scenario:check && npm run build` |
| Pre-deploy Command | — | `npm run migrate:deploy` |
| Start Command | `npm start` (по умолчанию, можно не задавать) | **`npm run worker:prod`** — задать обязательно |
| Replicas | 1 | 1 |
| Restart Policy | On Failure | On Failure |

Сборка, Replicas и Restart Policy уже заданы в `railway.json` в корне репозитория, вручную
у сервиса нужны только Start Command (worker) и Pre-deploy Command (worker). Без Start Command
worker запустится как бот (`npm start`) и получит `409 Conflict` с настоящим ботом.

Если упал long polling, bot сам завершается с ошибкой, и Railway его перезапускает.

**Variables** (одинаковые у обоих сервисов, удобно через Shared Variables):

| Переменная | Значение |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (ссылка на сервис базы) |
| `BOT_TOKEN` | токен боевого бота из @BotFather |
| `KC_BOT_USERNAME` | `CPSOSO_Bot` |
| `TZ` | `Europe/Moscow` |
| `COHORT_CUTOFF_MONTH_DAY` | `04-15` |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ID таблицы |
| `GOOGLE_SHEETS_SHEET_NAME` | `Лист1` |
| `GOOGLE_SHEETS_CLIENT_EMAIL` | email сервисного аккаунта Google |
| `GOOGLE_SHEETS_PRIVATE_KEY` | ключ сервисного аккаунта целиком, переносы строк как `\n` |

`ALLOW_RESET` **не задавать**: в боевом боте команда `/reset` выключена намеренно.
`REMINDER_TEST_MINUTES` **не задавать**: это тестовый режим, в нём сутки сжимаются до минут.

Значения переменных — из локального `.env`. Передавать через менеджер паролей, не в чате и не в git.

## 5. Проверка после запуска

- Логи bot: `Бот запущен (long polling).`, без ошибок `getMe`/`409 Conflict`.
  - `409 Conflict` — где-то запущен второй экземпляр. Найти и остановить.
- Логи worker: `Воркер поднят. Очередь напоминаний разбирается раз в минуту.` и
  `Sheets-синхронизация включена`.
- В Telegram: `/start` в боте показывает ваш текущий шаг.
- В Google-таблице через минуту обновляются строки.

## 6. Что передать техническому отделу

- Доступ к репозиторию и к проекту Railway.
- Владение ботом в @BotFather (или токен через менеджер паролей).
- Google Cloud: сервисный аккаунт `GOOGLE_SHEETS_CLIENT_EMAIL`. У него должен быть доступ
  «Редактор» к таблице.
- Этот файл, `CLAUDE.md`, `docs/Тарифы.md`.

## Что важно знать при эксплуатации

- **Google-таблица синхронизируется в обе стороны раз в минуту.** Правка ячейки попадает в бота.
  **Удаление строки в «Лист1» удаляет родителя из бота** вместе с прогрессом.
- Сроки в сценарии зашиты на учебный год **2026/2027**. До лета 2027 их нужно обновить в YAML.
- Резервные копии: включить Backups у сервиса Postgres в Railway.
- Точки отката в git: теги `Откат_*` (последний — `Откат_12.10.2026`).
- Админ-скрипты (`scripts/`) запускаются локально с `DATABASE_URL`, указывающим на Railway
  (`DATABASE_PUBLIC_URL`). `clear-sheet-rows.ts` чистит таблицу — **только при остановленном
  worker**, иначе он удалит родителей из базы.

## Как вносить изменения после переноса

1. Правка локально (тексты — `scenario/*.yaml`, картинки — `assets/`, код — `src/`).
2. Проверка: `npm run scenario:check`. Прогон — только на **тестовом** боте: свой токен из
   @BotFather в локальном `.env`, никогда не боевой (иначе локальная копия перехватит апдейты
   у Railway).
3. `git commit` → `git push` в `master` — Railway сам соберёт и выкатит новую версию.
   Если сценарий с ошибкой, сборка упадёт на `scenario:check` и продолжит работать старая версия.
4. Откат — Railway → Deployments → Redeploy предыдущей версии, или `git revert` + push.
