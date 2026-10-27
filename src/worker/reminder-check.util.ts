import type { User } from '@prisma/client';
import type { Reminder, Screen } from '../../scenario/schema';
import type { ScenarioService } from '../scenario/scenario.service';

export type ReminderCheck =
  | { ok: true; reminder: Reminder; source: Screen; stage: string }
  | { ok: false; reason: 'gone' | 'irrelevant' };

// Актуально ли ещё напоминание из очереди для родителя в его текущем
// состоянии. Общее для воркера (отправлять или снять) и Google-таблицы
// («бот напомнит такого-то числа» — только про то, что правда придёт).
// Пауза по этапу (mutedStages) сюда не входит: воркер обрабатывает её
// отдельно, с побочным эффектом (ставит этап на паузу).
export function checkReminder(scenario: ScenarioService, user: User, jobType: string): ReminderCheck {
  // jobType — "<экран-ожидание>:<номер в расписании>", см. scheduleReminders
  // в screen-renderer.service.ts. Сценарий мог измениться с момента
  // постановки задачи, поэтому проверяем, что экран и шаг ещё существуют.
  const [sourceId, indexRaw] = jobType.split(':');
  const source = scenario.hasScreen(sourceId) ? scenario.getScreen(sourceId) : undefined;
  const reminder = source?.reminders?.schedule[Number(indexRaw)];
  if (!source?.reminders || !reminder) return { ok: false, reason: 'gone' };

  // Родитель уже ушёл из зоны ожидания — значит подтвердил, что письмо
  // пришло. Оставшиеся напоминания по этому поводу больше не нужны.
  // У напоминания может быть своя зона (календарь выпускника).
  const waitingScreens = reminder.waitingScreens ?? source.reminders.waitingScreens;
  // Класс проверяется и при постановке, и здесь: родитель мог вернуться
  // и выбрать другой класс — даты старого класса ему уже не нужны.
  const wrongClass = reminder.forClass != null && !reminder.forClass.includes(user.class ?? '');
  // Экран «поверх шага» (продление: кнопки ведут на previous) — родитель
  // на нём не ушёл со своего шага, а просто ещё не закрыл его. Тогда
  // сверяемся с шагом под ним, иначе напоминание о шаге снялось бы навсегда.
  const current = scenario.hasScreen(user.stage) ? scenario.getScreen(user.stage) : undefined;
  const onTop = current?.buttons?.some((b) => b.next === 'previous') ?? false;
  const underlying = onTop ? user.historyStack[user.historyStack.length - 1] : undefined;
  const inZone = waitingScreens.includes(user.stage) || (underlying != null && waitingScreens.includes(underlying));
  // Отложенный этап 1: важен не экран, а то, вернулся ли родитель к платформе.
  const relevant = reminder.ifDeferred ? user.deferredStage1 : inZone;
  if (!relevant || wrongClass) return { ok: false, reason: 'irrelevant' };

  // Этап — тот, о котором напоминание: календарь выпускника ставится с одного
  // экрана, но молчание про собеседование не должно глушить напоминания об экзаменах.
  const stage = scenario.hasScreen(reminder.screen) ? scenario.getScreen(reminder.screen).stage : source.stage;
  return { ok: true, reminder, source, stage };
}
