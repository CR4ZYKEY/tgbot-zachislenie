import { InlineKeyboard } from 'grammy';
import { Button, Screen, SystemScreen } from '../../scenario/schema';
import { TemplateVars, renderTemplate } from './template.util';

// callback_data несёт screen_id + state_version — «Старые кнопки», п.1
// раздела 1 docs/spec.md. Разделитель "~" не входит в idRegex сценария,
// поэтому не пересекается с содержимым screen_id/data.
const SEP = '~';

export function encodeCallback(screenId: string, data: string, renderVersion: number): string {
  return [screenId, data, renderVersion.toString(36)].join(SEP);
}

export interface DecodedCallback {
  screenId: string;
  data: string;
  renderVersion: number;
}

export function decodeCallback(raw: string): DecodedCallback | null {
  const parts = raw.split(SEP);
  if (parts.length !== 3) return null;
  const [screenId, data, versionRaw] = parts;
  const renderVersion = parseInt(versionRaw, 36);
  if (!screenId || !data || Number.isNaN(renderVersion)) return null;
  return { screenId, data, renderVersion };
}

function addButtonRows(
  kb: InlineKeyboard,
  buttons: Button[] | undefined,
  screenId: string,
  renderVersion: number,
  perRow: number,
  urlVars: TemplateVars,
): void {
  if (!buttons?.length) return;
  for (let i = 0; i < buttons.length; i += perRow) {
    const row = buttons.slice(i, i + perRow);
    for (const b of row) {
      // Подпись тоже шаблон: «Решу ОГЭ» / «Решу ЕГЭ» по классу выпускника.
      const label = renderTemplate(b.label, urlVars);
      if (b.url) {
        kb.url(label, renderTemplate(b.url, urlVars));
      } else if (b.data) {
        kb.text(label, encodeCallback(screenId, b.data, renderVersion));
      }
    }
    kb.row();
  }
}

// Строит inline-клавиатуру для обычного экрана сценария: контентные кнопки
// (сеткой по 4 для screen.grid, иначе по 2 — «анатомия экрана» из раздела 1
// спеки), затем однострочные дополнительные кнопки (deferButton всегда,
// input.skipButton — только когда движок решил, что попытки исчерпаны) и
// служебный ряд «← Назад» / «☰ Меню».
export function buildScreenKeyboard(
  screen: Screen,
  renderVersion: number,
  opts: { backTarget?: string; urlVars?: TemplateVars; extraButtons?: Button[] } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const urlVars = opts.urlVars ?? {};

  addButtonRows(kb, screen.buttons, screen.id, renderVersion, screen.grid ? 4 : 2, urlVars);

  for (const b of opts.extraButtons ?? []) {
    if (b.data) kb.text(b.label, encodeCallback(screen.id, b.data, renderVersion)).row();
  }

  const serviceRow: Array<[string, string]> = [];
  if (opts.backTarget) serviceRow.push(['← Назад', encodeCallback(screen.id, '__back', renderVersion)]);
  if (screen.menu) serviceRow.push(['☰ Меню', encodeCallback(screen.id, '__menu', renderVersion)]);
  for (const [label, data] of serviceRow) kb.text(label, data);
  if (serviceRow.length) kb.row();

  return kb;
}

// Клавиатура для системных экранов-оверлеев (kc/menu/stale/...) — те же
// правила кодирования, но без back/menu/deferButton (это не часть карты пути).
// includeBack добавляет однотипную "← Назад" — родитель должен всегда иметь
// быстрый способ вернуться к прошлому сообщению, а не листать чат вручную.
// data "__overlay_back" — движковая, её нет в scenario.yaml (см. обработку
// в engine.service.ts), поэтому текст кнопки хардкодится здесь же, как и
// "← Назад" / "☰ Меню" у обычных экранов чуть выше.
export function buildSystemKeyboard(
  screen: SystemScreen,
  overlayId: string,
  renderVersion: number,
  urlVars: TemplateVars = {},
  opts: { includeBack?: boolean } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();
  addButtonRows(kb, screen.buttons, overlayId, renderVersion, 2, urlVars);
  if (opts.includeBack) {
    kb.text('← Назад', encodeCallback(overlayId, '__overlay_back', renderVersion)).row();
  }
  return kb;
}
