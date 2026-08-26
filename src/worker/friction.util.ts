// Общая эвристика "это ответ-затруднение?" — используется и в скрипте
// npm run stats, и в выгрузке статистики на вкладку "Статистика" таблицы
// (sheets-sync.service.ts). Один источник правды, чтобы цифры в консоли
// и в таблице не расходились.
export const FRICTION_MARKERS = ['.no', '.empty', '.unclear', '.notfound', '.missing', '.kc', '.need_time', '.later'];

export function isFrictionAnswer(value: string): boolean {
  return FRICTION_MARKERS.some((m) => value.includes(m));
}
