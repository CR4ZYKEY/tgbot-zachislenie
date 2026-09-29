// Сроки напоминаний. Боевые значения живут в сценарии в часах, но проверить
// цепочку «через сутки — через двое» на живом боте иначе можно было бы только
// за двое суток. REMINDER_TEST_MINUTES сжимает сутки в указанное число минут:
// 24ч -> N мин, 48ч -> 2N мин. В проде переменная не задаётся.
//
// Важно: в тестовом режиме сжимается ВСЁ, что меряется в сутках, — и сами
// сроки, и правило «не более одного касания в сутки». Иначе второе
// напоминание (через 2 минуты) упёрлось бы в 20-часовую паузу и никогда
// бы не пришло.

export function reminderTestMinutes(): number | null {
  const raw = Number(process.env.REMINDER_TEST_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function isReminderTestMode(): boolean {
  return reminderTestMinutes() !== null;
}

// Напоминание по дате уходит в 10:00 МСК — первая минута тихих часов
// (10:00–21:00 МСК, CLAUDE.md). Москва — UTC+3 круглый год, так что это
// 07:00 UTC того же дня.
export function reminderDateToRunAt(at: string): Date {
  return new Date(`${at}T07:00:00.000Z`);
}

// Часы по сценарию -> миллисекунды, с учётом тестового сжатия.
export function reminderHoursToMs(hours: number): number {
  const testMinutes = reminderTestMinutes();
  if (testMinutes !== null) return (hours / 24) * testMinutes * 60_000;
  return hours * 3_600_000;
}
