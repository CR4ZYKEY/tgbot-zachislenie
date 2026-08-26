// П.5 CLAUDE.md: паспортные данные, данные документов, сведения о здоровье
// не сохраняем никогда — свободные поля (имя, отзыв о Городе) фильтруются
// на входе. Эвристика: длинные цифровые последовательности (серии/номера
// документов, СНИЛС, даты в цифровом виде и т.п.) вырезаем, длину режем.

const LONG_DIGIT_RUN = /\d{6,}/g;
const MAX_LEN = 300;

export function sanitizeFreeText(raw: string): string {
  const trimmed = raw.trim().slice(0, MAX_LEN);
  return trimmed.replace(LONG_DIGIT_RUN, '[скрыто]');
}
