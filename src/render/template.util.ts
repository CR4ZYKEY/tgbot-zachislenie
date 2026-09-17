// Минимальный шаблонизатор текста экрана: {{#if field}}A{{else}}B{{/if}}
// и {{field}}. Ничего сложнее не нужно — сценарий описывает диалог, а не
// произвольную логику (см. комментарий в scenario/schema.ts у поля text).

export type TemplateVars = Record<string, unknown>;

const IF_BLOCK = /\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
const VAR = /\{\{(\w+)\}\}/g;

export function renderTemplate(text: string, vars: TemplateVars): string {
  const withConditions = text.replace(IF_BLOCK, (_m, field: string, whenTrue: string, whenFalse = '') =>
    vars[field] ? whenTrue : whenFalse,
  );
  return withConditions.replace(VAR, (_m, field: string) => (vars[field] != null ? String(vars[field]) : ''));
}
