// S2b, «детали реализации» из docs/spec.md: принимаем +7, 8, пробелы,
// скобки и дефисы — нормализуем на входе, не заставляем родителя гадать формат.

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  const stripped = digits.replace(/^\+/, '');

  let normalized: string | null = null;
  if (stripped.length === 11 && (stripped.startsWith('7') || stripped.startsWith('8'))) {
    normalized = `+7${stripped.slice(1)}`;
  } else if (stripped.length === 10 && stripped.startsWith('9')) {
    normalized = `+7${stripped}`;
  }

  if (!normalized) return null;
  return /^\+79\d{9}$/.test(normalized) ? normalized : null;
}
