// Zod-схема сценария. Раздел 8.9 CLAUDE.md / docs/spec.md: «дубль screen_id,
// переход на несуществующий экран, кнопка без обработчика — приложение
// не должно подняться». Эта схема — та самая проверка.
//
// Правки текстов и кнопок делаются только в scenario/scenario.yaml.
// Ни одной строки текста, показываемой родителю, здесь быть не должно.

import { z } from 'zod';

// Спецдействия движка, не являющиеся ни screen_id, ни ключом system.*:
// - current_screen — вернуться на актуальный экран пользователя (динамика,
//   не статика — используется в system.stale, «Да, к текущему шагу»);
// - status          — показать то же, что /status;
// - defer_to_stage2 — зарезервировано под симметричный перенос (раздел 0,
//   п.7 спеки: «если застрял на этапе 2 — предложить пройти этап 1»);
// - wait            — «Понятно», после которого бот ничего не показывает, а
//   ждёт своей даты (путь выпускника: g6_ready, g7_1, …). Родитель остаётся
//   на экране, у сообщения убираются кнопки ответа — дальше напишет
//   напоминание.
// - previous        — вернуться на экран, с которого пришли (как «← Назад»).
//   Для экранов, которые напоминание показывает поверх текущего шага
//   (продление со скидкой): ответили — и обратно к своему шагу.
// - dates           — «Важные сроки»: экран из packageVars.datesScreen по пакету
//   родителя (dates_none, пока пакет не выбран), показывается как оверлей.
export const SPECIAL_TARGETS = ['current_screen', 'status', 'defer_to_stage2', 'wait', 'previous', 'dates'] as const;

// Обязательные системные экраны — не часть карты пути, но текст в них
// показывается родителю, поэтому по правилу 1 CLAUDE.md тоже живёт в YAML.
export const SYSTEM_SCREEN_KEYS = [
  'kc', 'menu', 'stop', 'stale', 'phone_invalid', 'in_progress', 'status_complete', 'status_card', 'platform',
] as const;
export type SystemScreenKey = (typeof SYSTEM_SCREEN_KEYS)[number];

const idRegex = /^[a-z0-9_.]+$/;

// Кнопка может декларативно записать значение в профиль пользователя —
// без этого нажатие "Базовый"/"1 класс"/"Впервые" оставалось бы только
// строкой в answers (лог "Затруднений"), а поля users.package/class/
// isReturning так и не заполнялись бы, хотя раздел 8 спеки требует их хранить.
export const SetFieldSchema = z.object({
  field: z.enum(['package', 'class', 'isReturning']),
  // Всегда строка в YAML; isReturning движок коэрсит в boolean ("true"/"false").
  value: z.string(),
});

export const ButtonSchema = z
  .object({
    // Текст кнопки — единственное место, где допустим свободный текст в этом узле.
    label: z.string().min(1, 'у кнопки должен быть текст'),
    // callback_data, несёт screen_id + state_version по правилу «старые кнопки» (п.1 спеки).
    data: z.string().regex(idRegex, 'callback_data: только a-z0-9_.').optional(),
    // Куда ведёт нажатие: screen_id, ключ system.* или один из SPECIAL_TARGETS.
    next: z.string().regex(idRegex).optional(),
    // Кнопка-ссылка (деплинк в бот КС) вместо callback — см. system.kc.
    // Плейсхолдеры {{kc_username}} / {{kc_context}} подставляет движок.
    url: z.string().min(1).optional(),
    // Одно поле или несколько: «11 класс» в «Классном» пишет и класс, и
    // тариф «Классный Выпускник».
    setField: z.union([SetFieldSchema, z.array(SetFieldSchema).min(1)]).optional(),
    // Файл, который бот присылает по нажатию (памятка МЦКО на g5_mcko) —
    // путь относительно assets/, как у image. Имя файла у родителя — имя
    // файла на диске, поэтому называть его по-русски и по-человечески.
    // Без next родитель остаётся на том же экране.
    document: z.string().min(1).optional(),
  })
  .refine((b) => Boolean(b.url) !== Boolean(b.data), {
    message: 'кнопка должна быть либо callback (data), либо ссылкой (url) — не оба и не ни одного',
  })
  .refine((b) => !b.document || Boolean(b.data), {
    message: 'document бывает только у callback-кнопки (data)',
  });
export type Button = z.infer<typeof ButtonSchema>;

export const FreeInputSchema = z.object({
  // Ровно три места во всём сценарии — проверяется отдельно, ниже.
  field: z.enum(['name', 'phone', 'city_feedback']),
  next: z.string().regex(idRegex),
  validation: z.enum(['none', 'phone']).default('none'),
  maxAttempts: z.number().int().positive().optional(),
  // Кнопка «Пропустить», появляющаяся после исчерпания попыток (S2b).
  skipButton: ButtonSchema.optional(),
});
export type FreeInput = z.infer<typeof FreeInputSchema>;

// Напоминания, привязанные к экрану-«ожиданию»: ставятся в очередь `jobs`,
// как только родитель на этот экран попадает, и снимаются сами, как только
// он из зоны ожидания вышел (значит вопрос уже решён). Живёт в сценарии,
// а не в коде, чтобы сроки и тексты правились в одном месте (правило 1
// CLAUDE.md).
//
// Два вида триггеров (модель напоминаний, CLAUDE.md), в одной записи — ровно один:
//   afterHours — относительный: через N часов после попадания на экран;
//   at         — абсолютный: конкретная дата календаря ("2026-11-11"),
//                отправка в 10:00 МСК — начало тихих часов.
export const ReminderSchema = z
  .object({
    // Через сколько часов после попадания на экран. Для ручных прогонов сутки
    // сжимаются переменной REMINDER_TEST_MINUTES — см. reminder-timing.util.ts.
    afterHours: z.number().positive().optional(),
    // Конкретная дата. Прошедшие даты не ставятся вовсе, как и даты ближе
    // minDaysFromStart к старту родителя в боте (CLAUDE.md). REMINDER_TEST_MINUTES
    // на даты не действует — это календарь, его не сожмёшь.
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'at: дата в формате ГГГГ-ММ-ДД')
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'at: несуществующая дата')
      .optional(),
    // Только для at. CLAUDE.md: «абсолютный триггер ближе 14 дней от старта не
    // создаётся» — это умолчание. Для жёстких дедлайнов (заявление на ГИА)
    // молчать нельзя, там можно поставить 0.
    minDaysFromStart: z.number().int().min(0).optional(),
    // Напоминание только родителям этих классов (поле профиля class). Нужно,
    // когда у 9 и 11 класса разные даты — например, собеседование и сочинение.
    forClass: z.array(z.string().min(1)).min(1).optional(),
    // Своя зона ожидания у этого напоминания вместо общей (reminders.waitingScreens).
    // Нужна календарю выпускника: он ставится одним списком в начале пути, а
    // у каждой даты свой «шаг ещё не сделан» — про заявление спрашиваем, пока
    // родитель на шагах 3–4, про собеседование — пока он не дошёл до шага 6.
    waitingScreens: z.array(z.string().regex(idRegex)).min(1).optional(),
    // Только для afterHours: при новом заходе на экран уже отправленное
    // напоминание ставится заново. Для «спрошу ещё раз через неделю», которое
    // повторяется, пока родитель не ответит (до паузы после трёх молчаний).
    rearm: z.boolean().optional(),
    // Не отправлять, если родитель уже нажал одну из этих кнопок (callback data)
    // — например, «Уже продлили»: напоминание о продлении больше не нужно,
    // хотя сам шаг, на котором родитель стоит, от этого не меняется.
    skipIfAnswered: z.array(z.string().regex(idRegex)).min(1).optional(),
    // Какой экран показать. Каждое напоминание — свой экран со своим текстом:
    // повторять слово в слово нельзя, иначе выглядит как сбой рассылки.
    screen: z.string().regex(idRegex),
  })
  .refine((r) => (r.afterHours != null) !== (r.at != null), {
    message: 'напоминание задаётся либо afterHours, либо at — не оба и не ни одного',
  })
  .refine((r) => r.minDaysFromStart == null || r.at != null, {
    message: 'minDaysFromStart имеет смысл только у напоминания по дате (at)',
  })
  .refine((r) => !r.rearm || r.afterHours != null, {
    message: 'rearm имеет смысл только у напоминания afterHours',
  });
export type Reminder = z.infer<typeof ReminderSchema>;

export const RemindersSchema = z.object({
  // Пока родитель на любом из этих экранов — вопрос ещё открыт. Ушёл дальше
  // (подтвердил, что письмо пришло) — оставшиеся напоминания отменяются.
  waitingScreens: z.array(z.string().regex(idRegex)).min(1),
  schedule: z.array(ReminderSchema).min(1),
});
export type Reminders = z.infer<typeof RemindersSchema>;

export const ScreenSchema = z.object({
  id: z.string().regex(idRegex, 'screen_id: только a-z0-9_.'),
  // Этап для префикса «Шаг N из 6 · Название этапа» и для группировки в /status.
  stage: z.string().min(1),
  stepLabel: z.string().optional(),
  // Текст поддерживает лёгкий движковый шаблон {{#if field}}..{{else}}..{{/if}}
  // для веток вроде «впервые / уже учились» (E2.2) — без этого пришлось бы
  // заводить два screen_id на одну и ту же логическую развилку.
  text: z.string().min(1, 'у экрана должен быть текст'),
  // Путь к скриншоту-инструкции (E1.6b и т.п.) — сами картинки вне сценария.
  image: z.string().optional(),
  // Максимум 4 кнопки — проверяется в superRefine ниже (там же учитывается
  // исключение grid), а не тут, чтобы обе проверки шли по одному пути.
  buttons: z.array(ButtonSchema).optional(),
  // Исключение из правила 2–4: сетки выбора (класс — S4, предметы — Э3/Э4),
  // см. п.9 раздела 0 docs/spec.md.
  grid: z.boolean().optional(),
  input: FreeInputSchema.optional(),
  // "← Назад" — используется только как ОТКЛОНЕНИЕ от дефолта (реальный
  // предыдущий экран из истории пользователя, которую ведёт движок, а не
  // сценарий). Нужен там, где по спеке "на первом экране этапа = «К карте
  // пути»" (E1.1, E2.0), а не на экранах со слиянием нескольких путей.
  back: z.string().regex(idRegex).optional(),
  // "☰ Меню" в служебном ряду.
  menu: z.boolean().optional(),
  // "Зайду на платформу позже — к зачислению" (доступна на E1.1–E1.6).
  deferButton: ButtonSchema.optional(),
  // Экран считается концом построенного пути (сейчас — конец Этапа 2, до
  // появления этапов 3–6). "Статус зачисления" из меню на таком экране
  // показывает system.status_complete вместо повтора самого экрана.
  terminal: z.boolean().optional(),
  // Экран-«ожидание»: попав сюда, родитель получает напоминания по расписанию
  // (см. ReminderSchema). Обрабатывает воркер, не бот.
  reminders: RemindersSchema.optional(),
});
export type Screen = z.infer<typeof ScreenSchema>;

// Системные экраны-оверлеи (не меняют stage пользователя, кроме stop).
// text — обязателен (правило 1 CLAUDE.md), buttons — опциональны.
export const SystemScreenSchema = z.object({
  text: z.string().min(1),
  // Путь к картинке-заглушке (сейчас — "раздел в разработке" на in_progress),
  // тот же формат и то же место хранения (assets/shots), что у ScreenSchema.
  image: z.string().optional(),
  buttons: z.array(ButtonSchema).max(4).optional(),
});
export type SystemScreen = z.infer<typeof SystemScreenSchema>;

export const SystemScreensSchema = z.object({
  // Оверлей «Написать в КС» — deep-link с контекстом шага (раздел 0, п.5 спеки).
  kc: SystemScreenSchema,
  // "☰ Меню" — раздел 5 спеки.
  menu: SystemScreenSchema,
  // Ответ на S1a «Удалить мои данные» — переход в stop реально стирает записи.
  stop: SystemScreenSchema,
  // «Старые кнопки», п.1 раздела 1 спеки.
  stale: SystemScreenSchema,
  // Невалидный формат телефона на S2b (до исчерпания попыток).
  phone_invalid: SystemScreenSchema,
  // Мягкий тупик для разделов меню, которых ещё нет (этапы 3–6).
  in_progress: SystemScreenSchema,
  // "Статус зачисления" из меню, когда экран пользователя помечен
  // screen.terminal (см. ScreenSchema) — вместо повтора финального экрана.
  status_complete: SystemScreenSchema,
  // "Статус зачисления" из меню, пока путь не пройден: пакет, класс, текущий шаг.
  status_card: SystemScreenSchema,
  // "Платформа" из меню: где смотреть аттестации, ссылка на главную.
  platform: SystemScreenSchema,
});
export type SystemScreens = z.infer<typeof SystemScreensSchema>;

export const ScenarioSchema = z
  .object({
    version: z.string(),
    // Флаги для шаблонов по тарифу: {{#if hasCurator}}…{{/if}} истинно, если
    // package родителя — один из перечисленных. Живут в сценарии, чтобы новый
    // тариф подключался без правки кода.
    packageFlags: z.record(z.string().regex(/^\w+$/), z.array(z.string().min(1)).min(1)).optional(),
    // Значения для шаблонов по тарифу: {{curatorUrl}} — ссылка на куратора
    // того тарифа, который выбрал родитель (у выпускников и «Классного» разные).
    packageVars: z.record(z.string().regex(/^\w+$/), z.record(z.string(), z.string())).optional(),
    // Мелкие подписи интерфейса, которые ставит движок (правило 1 CLAUDE.md:
    // и они — в сценарии). answeredPrefix — перед выбранным ответом на
    // прошлом сообщении: «✓ Да, отправил».
    ui: z.object({ answeredPrefix: z.string().default('') }).optional(),
    screens: z.array(ScreenSchema).min(1),
    system: SystemScreensSchema,
  })
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();

    for (const screen of scenario.screens) {
      if (ids.has(screen.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Дубль screen_id: "${screen.id}"`,
        });
      }
      ids.add(screen.id);

      if (screen.buttons && screen.buttons.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Экран "${screen.id}": buttons задан пустым массивом`,
        });
      }

      if (!screen.grid && (screen.buttons?.length ?? 0) > 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Экран "${screen.id}": больше 4 кнопок без флага grid`,
        });
      }
    }

    const isValidTarget = (t: string) =>
      ids.has(t) ||
      (SYSTEM_SCREEN_KEYS as readonly string[]).includes(t) ||
      (SPECIAL_TARGETS as readonly string[]).includes(t);

    const checkScreenRefs = (screenLabel: string, buttons: Button[] | undefined, extra: Array<{ target: string; where: string }>) => {
      const refs: Array<{ target: string; where: string }> = [...extra];
      for (const [i, b] of (buttons ?? []).entries()) {
        if (b.url) continue; // ссылки не проверяем на screen_id
        if (b.next) refs.push({ target: b.next, where: `buttons[${i}] (${b.data})` });
      }
      for (const ref of refs) {
        if (!isValidTarget(ref.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${screenLabel}: ${ref.where} ссылается на несуществующий screen_id "${ref.target}"`,
          });
        }
      }
      // Callback-кнопка без next — тупик, приложение не должно подняться.
      for (const [i, b] of (buttons ?? []).entries()) {
        if (!b.url && !b.next && !b.document) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${screenLabel}: buttons[${i}] (${b.data}) без next — кнопка без обработчика`,
          });
        }
      }
      // Дубли callback_data в пределах экрана.
      const seen = new Set<string>();
      for (const b of buttons ?? []) {
        if (!b.data) continue;
        if (seen.has(b.data)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${screenLabel}: повторный callback_data "${b.data}"`,
          });
        }
        seen.add(b.data);
      }
    };

    const allButtonData = new Set(
      scenario.screens.flatMap((s) => [...(s.buttons ?? []), ...(s.deferButton ? [s.deferButton] : [])].map((b) => b.data ?? '')),
    );

    for (const screen of scenario.screens) {
      const extra: Array<{ target: string; where: string }> = [];
      if (screen.input) extra.push({ target: screen.input.next, where: 'input.next' });
      if (screen.back) extra.push({ target: screen.back, where: 'back' });
      if (screen.deferButton) {
        if (screen.deferButton.next) extra.push({ target: screen.deferButton.next, where: 'deferButton' });
        else if (!screen.deferButton.url) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Экран "${screen.id}": deferButton без next`,
          });
        }
      }
      checkScreenRefs(`Экран "${screen.id}"`, screen.buttons, extra);

      // Напоминания: и экран напоминания, и вся зона ожидания должны
      // существовать. Опечатка тут тише всех прочих — воркер молча не нашёл
      // бы экран через сутки после действия родителя, уже без свидетелей.
      if (screen.reminders) {
        for (const [i, r] of screen.reminders.schedule.entries()) {
          if (!ids.has(r.screen)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Экран "${screen.id}": reminders.schedule[${i}].screen ссылается на несуществующий screen_id "${r.screen}"`,
            });
          }
          for (const w of r.waitingScreens ?? []) {
            if (!ids.has(w)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Экран "${screen.id}": reminders.schedule[${i}].waitingScreens содержит несуществующий screen_id "${w}"`,
              });
            }
          }
        }
        for (const [i, r] of screen.reminders.schedule.entries()) {
          for (const v of r.skipIfAnswered ?? []) {
            if (!allButtonData.has(v)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Экран "${screen.id}": reminders.schedule[${i}].skipIfAnswered — нет кнопки с data "${v}"`,
              });
            }
          }
        }
        for (const w of screen.reminders.waitingScreens) {
          if (!ids.has(w)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Экран "${screen.id}": reminders.waitingScreens содержит несуществующий screen_id "${w}"`,
            });
          }
        }
        // Сам экран-ожидание обязан быть в зоне ожидания: иначе первое же
        // напоминание отменится как «родитель уже ушёл дальше».
        if (!screen.reminders.waitingScreens.includes(screen.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Экран "${screen.id}": сам экран должен быть в reminders.waitingScreens, иначе напоминания отменятся сразу же`,
          });
        }
      }
    }

    // «Важные сроки» показывают экран по пакету — опечатка в id тихо отдала бы
    // родителю пустой экран dates_none.
    for (const [pkg, id] of Object.entries(scenario.packageVars?.datesScreen ?? {})) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `packageVars.datesScreen["${pkg}"] ссылается на несуществующий экран "${id}"`,
        });
      }
    }
    if (scenario.packageVars?.datesScreen && !ids.has('dates_none')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Нет экрана dates_none для «Важных сроков» без пакета' });
    }

    for (const key of SYSTEM_SCREEN_KEYS) {
      checkScreenRefs(`system.${key}`, scenario.system[key].buttons, []);
    }

    // Критерий приёмки 1 / п.4 CLAUDE.md: свободный ввод ровно в трёх местах.
    // Имя и телефон — строго по одному экрану (они на общем старте). Отзыв о
    // Городе — одно место по смыслу, но у каждой ветки тарифа своя копия
    // этапа 1 (E1.5b, g1_5b, bg1_5b, …): копий сколько угодно, лишь бы это был
    // один и тот же вопрос — текст у всех одинаковый.
    const inputScreens = scenario.screens.filter((s) => s.input);
    const freeInputFields = inputScreens.map((s) => s.input!.field);
    const allowedFields: FreeInput['field'][] = ['name', 'phone', 'city_feedback'];
    for (const field of ['name', 'phone'] as const) {
      const count = freeInputFields.filter((f) => f === field).length;
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Поле свободного ввода "${field}" встречается ${count} раз(а) — должно быть не больше 1`,
        });
      }
    }
    const feedbackTexts = new Set(inputScreens.filter((s) => s.input!.field === 'city_feedback').map((s) => s.text));
    if (feedbackTexts.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Экраны отзыва о Городе (city_feedback) должны быть копиями одного вопроса — тексты различаются',
      });
    }
    const unexpected = freeInputFields.filter((f) => !allowedFields.includes(f));
    if (unexpected.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Неожиданные поля свободного ввода: ${unexpected.join(', ')}`,
      });
    }
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
