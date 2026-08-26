# Telegram-бот «Зачисление в школу»

Правила проекта и жёсткие ограничения — [CLAUDE.md](CLAUDE.md).
Полная спецификация экранов и переходов — [docs/spec.md](docs/spec.md).

## Статус

Инициализация проекта (см. `docs/spec.md`, раздел 8.9, шаги 1–3):

- [x] 1. Сценарий в YAML — [scenario/scenario.yaml](scenario/scenario.yaml): разделы 2–4 спеки
      (Старт S0–S6, Этап 1 доступ, Этап 2 зачисление).
- [x] 2. Схема БД — [prisma/schema.prisma](prisma/schema.prisma).
- [x] 3. Zod-схема сценария — [scenario/schema.ts](scenario/schema.ts) + `npm run scenario:check`.
- [ ] 4. Движок: рендер экрана из YAML, обработка callback, запись ответа, переход.
- [ ] 5. Этапы 1–2 целиком (тексты описаны, обработчики — нет).
- [ ] 6. Меню, статус, сроки, КС (раздел 5 спеки).
- [ ] 7. Воркер напоминаний (раздел 8, «Модель напоминаний»).
- [ ] 8. Этапы 3–6 и чек-лист аттестаций (раздел 6 спеки).

`src/bot/main.ts` и `src/worker/main.ts` — заглушки: поднимают Nest-контекст
и валидируют сценарий при старте, но grammY-провайдер, движок сценария и
обработчик очереди `jobs` ещё не подключены.

## Команды

```bash
npm install
docker compose up -d postgres   # если есть docker-compose.yml — иначе локальный Postgres
npx prisma migrate dev
npm run scenario:check
npm run start:dev               # бот
npm run worker:dev              # воркер, отдельный процесс
```

Перед первым запуском скопируйте `.env.example` в `.env` и укажите
тестовый токен из @BotFather (не боевой — см. CLAUDE.md, раздел «Чего не делать»).
