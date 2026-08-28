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
//   п.7 спеки: «если застрял на этапе 2 — предложить пройти этап 1»).
export const SPECIAL_TARGETS = ['current_screen', 'status', 'defer_to_stage2'] as const;

// Обязательные системные экраны — не часть карты пути, но текст в них
// показывается родителю, поэтому по правилу 1 CLAUDE.md тоже живёт в YAML.
export const SYSTEM_SCREEN_KEYS = ['kc', 'menu', 'stop', 'stale', 'phone_invalid', 'in_progress', 'status_complete'] as const;
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
    setField: SetFieldSchema.optional(),
  })
  .refine((b) => Boolean(b.url) !== Boolean(b.data), {
    message: 'кнопка должна быть либо callback (data), либо ссылкой (url) — не оба и не ни одного',
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
});
export type Screen = z.infer<typeof ScreenSchema>;

// Системные экраны-оверлеи (не меняют stage пользователя, кроме stop).
// text — обязателен (правило 1 CLAUDE.md), buttons — опциональны.
export const SystemScreenSchema = z.object({
  text: z.string().min(1),
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
});
export type SystemScreens = z.infer<typeof SystemScreensSchema>;

export const ScenarioSchema = z
  .object({
    version: z.string(),
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
        if (!b.url && !b.next) {
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
    }

    for (const key of SYSTEM_SCREEN_KEYS) {
      checkScreenRefs(`system.${key}`, scenario.system[key].buttons, []);
    }

    // Критерий приёмки 1 / п.4 CLAUDE.md: свободный ввод ровно в трёх местах.
    const freeInputFields = scenario.screens
      .filter((s) => s.input)
      .map((s) => s.input!.field);
    const allowedFields: FreeInput['field'][] = ['name', 'phone', 'city_feedback'];
    for (const field of allowedFields) {
      const count = freeInputFields.filter((f) => f === field).length;
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Поле свободного ввода "${field}" встречается ${count} раз(а) — должно быть ровно 1`,
        });
      }
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
