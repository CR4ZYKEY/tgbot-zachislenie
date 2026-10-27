import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { ScreenRendererService } from '../render/screen-renderer.service';
import { renderTemplate, TemplateVars } from '../render/template.util';
import type { Reminder, Screen } from '../../scenario/schema';
import { normalizePhone } from '../bot/phone.util';
import { isFrictionAnswer } from './friction.util';
import { checkReminder } from './reminder-check.util';

// Google-таблица для сотрудников школы, обновляется раз в минуту.
// Цель — с одного взгляда понять, кто где, у кого что не так и что делать.
//
// Вкладки:
//   "Родители"   — строка на путь (герой родителя). Имя, телефон, пакет и
//                  класс можно править — правка уходит в бота. Остальное
//                  считает бот и перезаписывает.
//   "Ответы"     — журнал: кто, когда, на какой вопрос бота что нажал.
//   "Напоминания" — общие (календарь тарифа) и персональные (после действий
//                  родителя), только те, что правда придут.
//   "Статистика" — сводка по статусам, шагам и проблемным вопросам.
//   "Как читать" — пояснения к колонкам и цветам.
//
// Кто правил последним: для каждого пути храним sheetSyncHash — хеш четырёх
// редактируемых ячеек, какими бот их записал. Ячейки в таблице с другим
// хешем правили руками — правку проверяем и применяем в БД, негодную
// (неизвестный пакет, класс не 1–11) откатываем.
//
// Удалённая руками строка возвращается на следующем тике: удалить родителя
// можно только из бота (S1a «Удалить мои данные»). Строки родителей, которых
// в БД больше нет, бот из таблицы убирает сам.
//
// Тексты на вкладках — для сотрудников, а не для родителя, поэтому живут
// здесь, а не в сценарии.

const STATUS = {
  help: 'Нужна помощь',
  silent: 'Молчит',
  deferred: 'Отложено',
  notStarted: 'Не начато',
  ok: 'Идёт по плану',
} as const;

// Цвет фона ячейки «Статус» — условное форматирование на вкладке.
const STATUS_COLORS: Array<[string, string]> = [
  [STATUS.help, '#f4c7c3'],
  [STATUS.silent, '#fce8b2'],
  [STATUS.deferred, '#d2e3fc'],
  [STATUS.notStarted, '#e8eaed'],
  [STATUS.ok, '#ceead6'],
];

// Колонки "Родители". Первые EDITABLE — редактируемые, id — последней.
const PARENTS_COLUMNS: Array<{ title: string; note: string; width: number }> = [
  { title: 'Родитель', note: 'Имя, как родитель назвался боту. Можно исправить — уйдёт в бота.', width: 150 },
  { title: 'Телефон', note: 'Можно исправить — уйдёт в бота.', width: 130 },
  { title: 'Пакет', note: 'Выбирается из списка. Меняет ветку пути в боте.', width: 150 },
  { title: 'Класс', note: 'От 1 до 11, выбирается из списка. Меняет ветку пути в боте.', width: 75 },
  { title: 'Шаг', note: 'Шаг пути, на котором родитель сейчас. Заполняет бот.', width: 230 },
  { title: 'Статус', note: 'Нужна помощь / Молчит / Отложено / Не начато / Идёт по плану — см. вкладку «Как читать». Заполняет бот.', width: 120 },
  { title: 'Что происходит / что сделать', note: 'Почему такой статус и что можно сделать. Заполняет бот.', width: 380 },
  { title: 'Последний раз в боте', note: 'Когда родитель последний раз сам нажал кнопку или написал. Напоминания бота не считаются.', width: 130 },
  { title: 'Пришёл в бот', note: 'Дата первого /start.', width: 100 },
  { title: 'Впервые / продлевает', note: 'Новый родитель или продлевает обучение.', width: 110 },
  { title: 'Telegram ID', note: 'Служебное. Не трогать.', width: 110 },
  { title: 'Герой №', note: 'Служебное: номер героя у родителя, если их несколько. Не трогать.', width: 60 },
  { title: 'Код экрана', note: 'Служебное: экран сценария, на котором родитель. Для разработчиков. Не трогать.', width: 130 },
  // Номер в заголовке — версия оформления: поменяли цвета или списки —
  // увеличить, и вкладка переоформится сама.
  { title: 'id (3)', note: 'Служебное: по нему бот узнаёт строку. Не трогать.', width: 60 },
];
const EDITABLE = 4;
const COLS = PARENTS_COLUMNS.length;
const ID_COL = COLS - 1;
const LAST_COL = colLetter(COLS - 1);
// Первая служебная колонка (Telegram ID) — от неё и до конца серым.
const SERVICE_FROM = 10;

const ANSWERS_COLUMNS: Array<{ title: string; width: number }> = [
  { title: 'Когда', width: 120 },
  { title: 'Родитель', width: 150 },
  { title: 'Пакет, класс', width: 170 },
  { title: 'Шаг', width: 230 },
  { title: 'Вопрос бота', width: 340 },
  { title: 'Что ответил', width: 260 },
  { title: 'Затруднение', width: 115 },
  { title: 'Telegram ID', width: 110 },
];
const ANSWERS_CURSOR_KEY = 'answers_sheet';

// Тариф по этапу экрана — для общих (календарных) напоминаний: у экрана нет
// поля «тариф», а этапы у веток свои (docs/Тарифы.md).
const TARIFF_BY_STAGE: Array<[RegExp, string]> = [
  [/^stage/, 'Базовый · 1–8, 10 класс'],
  [/^graduate/, 'Базовый без ГИА · 9, 11 класс'],
  [/^bgia/, 'Базовый с ГИА · 9, 11 класс'],
  [/^kcl/, 'Классный · 1–8, 10 класс'],
  [/^kvyp/, 'Классный · 9, 11 класс'],
];
const PERSONAL_LIMIT = 500;

// Тихие часы воркера (reminders.service.ts): то, что выпало на ночь, уйдёт в 10:00 МСК.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
function daytime(d: Date): Date {
  const msk = new Date(d.getTime() + MSK_OFFSET_MS);
  const hour = msk.getUTCHours();
  if (hour >= 10 && hour < 21) return d;
  const day = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + (hour >= 21 ? 1 : 0), 10);
  return new Date(day - MSK_OFFSET_MS);
}

function daysText(hours: number): string {
  if (hours < 24) return `${hours} ч`;
  const n = Math.round(hours / 24);
  const word = n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней';
  return `${n} ${word}`;
}

// Меняется вместе с текстом вкладки "Как читать" — тогда она перепишется.
const GUIDE_VERSION = 'v3';

function colLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

function rgb(hex: string): sheets_v4.Schema$Color {
  const n = parseInt(hex.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

function plain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function moscowDateTime(d: Date): string {
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
}

function moscowDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

function moscowDayMonth(d: Date): string {
  return d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
}

function hashEditable(cells: string[]): string {
  return createHash('sha1').update(JSON.stringify(cells.slice(0, EDITABLE).map((c) => c ?? ''))).digest('hex');
}

function padRow(cells: string[], width: number): string[] {
  const out = cells.slice(0, width).map((c) => c ?? '');
  while (out.length < width) out.push('');
  return out;
}

type LastAnswer = { screenId: string; value: string; createdAt: Date };
type ParentRowContext = { last?: LastAnswer; nextReminder?: Date };
type ParentRow = { user: User; row: string[] };
// Напоминание из очереди, которое правда придёт.
type Upcoming = { user: User; jobType: string; runAt: Date; reminder: Reminder; source: Screen };

@Injectable()
export class SheetsSyncService implements OnModuleInit {
  private readonly logger = new Logger(SheetsSyncService.name);
  private sheets: sheets_v4.Sheets | null = null;
  private spreadsheetId = '';
  private parentsSheetName = 'Родители';
  private answersSheetName = 'Ответы';
  private remindersSheetName = 'Напоминания';
  private statsSheetName = 'Статистика';
  private guideSheetName = 'Как читать';
  private enabled = false;
  // Пакеты, которые бывают в сценарии, — список для ячейки «Пакет» и
  // проверка ручной правки.
  private packages: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
    private readonly renderer: ScreenRendererService,
  ) {}

  onModuleInit(): void {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? '';
    this.parentsSheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Родители';
    this.answersSheetName = process.env.GOOGLE_SHEETS_ANSWERS_SHEET_NAME ?? 'Ответы';
    this.statsSheetName = process.env.GOOGLE_SHEETS_STATS_SHEET_NAME ?? 'Статистика';
    const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!this.spreadsheetId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Sheets-синхронизация выключена: не заданы GOOGLE_SHEETS_SPREADSHEET_ID / _CLIENT_EMAIL / _PRIVATE_KEY в .env',
      );
      return;
    }

    const packages = new Set<string>();
    for (const screen of this.scenario.screens) {
      for (const button of screen.buttons ?? []) {
        for (const set of [button.setField ?? []].flat()) {
          if (set.field === 'package') packages.add(set.value);
        }
      }
    }
    this.packages = [...packages];

    const auth = new JWT({ email: clientEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.enabled = true;
    this.logger.log(`Sheets-синхронизация включена: таблица ${this.spreadsheetId}, вкладка "${this.parentsSheetName}"`);
  }

  async syncOnce(): Promise<void> {
    if (!this.enabled || !this.sheets) return;

    try {
      const tabs = await this.ensureTabs();
      const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
      const upcoming = await this.upcoming(users);
      const parents = await this.syncParents(tabs.get(this.parentsSheetName)!, users, upcoming);
      await this.syncAnswers(tabs.get(this.answersSheetName)!);
      await this.syncReminders(tabs.get(this.remindersSheetName)!, upcoming);
      await this.syncStats(tabs.get(this.statsSheetName)!, parents);
      await this.syncGuide(tabs.get(this.guideSheetName)!);
    } catch (err) {
      this.logger.error(`Ошибка синхронизации с Google Sheets: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ─────────── Вкладки ───────────

  // Создаёт недостающие вкладки, возвращает их sheetId по имени.
  private async ensureTabs(): Promise<Map<string, number>> {
    const names = [this.parentsSheetName, this.answersSheetName, this.remindersSheetName, this.statsSheetName, this.guideSheetName];
    const meta = await this.sheets!.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' });
    const ids = new Map<string, number>();
    for (const s of meta.data.sheets ?? []) {
      if (s.properties?.title != null && s.properties.sheetId != null) ids.set(s.properties.title, s.properties.sheetId);
    }
    const missing = names.filter((n) => !ids.has(n));
    if (missing.length) {
      const created = await this.sheets!.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title, index: names.indexOf(title) } } })) },
      });
      for (const reply of created.data.replies ?? []) {
        const p = reply.addSheet?.properties;
        if (p?.title != null && p.sheetId != null) ids.set(p.title, p.sheetId);
      }
    }
    return ids;
  }

  // Шапка не та (новая вкладка или поменялись колонки) — пишем шапку и
  // оформление заново. Возвращает true, если вкладку пришлось переделать.
  private async ensureHeader(name: string, sheetId: number, titles: string[], format: () => sheets_v4.Schema$Request[]): Promise<boolean> {
    const range = `${name}!A1:${colLetter(titles.length - 1)}1`;
    const res = await this.sheets!.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    const current = padRow(res.data.values?.[0] ?? [], titles.length);
    if (current.every((c, i) => c === titles[i])) return false;

    // Старое оформление убираем, чтобы правила не копились дублями.
    const meta = await this.sheets!.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      ranges: [name],
      fields: 'sheets(conditionalFormats,protectedRanges(protectedRangeId),basicFilter)',
    });
    const sheet = meta.data.sheets?.[0];
    const cleanup: sheets_v4.Schema$Request[] = [
      ...(sheet?.conditionalFormats ?? []).map(() => ({ deleteConditionalFormatRule: { sheetId, index: 0 } })),
      ...(sheet?.protectedRanges ?? []).map((p) => ({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId! } })),
      ...(sheet?.basicFilter ? [{ clearBasicFilter: { sheetId } }] : []),
    ];

    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [titles] },
    });
    await this.sheets!.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          ...cleanup,
          { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: rgb('#e6ecf5'),
                  wrapStrategy: 'WRAP',
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)',
            },
          },
          ...format(),
        ],
      },
    });
    return true;
  }

  private columnWidths(sheetId: number, widths: number[]): sheets_v4.Schema$Request[] {
    return widths.map((pixelSize, i) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    }));
  }

  // ─────────── Родители ───────────

  private parentsFormat(sheetId: number): sheets_v4.Schema$Request[] {
    const dataRows = { sheetId, startRowIndex: 1 };
    const cols = (from: number, to: number) => ({ ...dataRows, startColumnIndex: from, endColumnIndex: to });
    return [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenColumnCount: 1 } }, fields: 'gridProperties.frozenColumnCount' } },
      ...this.columnWidths(sheetId, PARENTS_COLUMNS.map((c) => c.width)),
      // Подсказка к каждой колонке — при наведении на заголовок.
      ...PARENTS_COLUMNS.map((c, i) => ({
        repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { note: c.note }, fields: 'note' },
      })),
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1 },
          cell: { userEnteredFormat: { verticalAlignment: 'TOP', wrapStrategy: 'WRAP', textFormat: { bold: false } } },
          fields: 'userEnteredFormat(verticalAlignment,wrapStrategy,textFormat)',
        },
      },
      // Телефон — текстом, иначе Google превратит +7… в число.
      { repeatCell: { range: cols(1, 2), cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } },
      // Что заполняет бот — на сером фоне, служебное — ещё и серым шрифтом.
      { repeatCell: { range: cols(EDITABLE, COLS), cell: { userEnteredFormat: { backgroundColor: rgb('#f8f9fa') } }, fields: 'userEnteredFormat.backgroundColor' } },
      {
        repeatCell: {
          range: cols(SERVICE_FROM, COLS),
          cell: { userEnteredFormat: { textFormat: { foregroundColor: rgb('#9aa0a6'), fontSize: 9 } } },
          fields: 'userEnteredFormat.textFormat',
        },
      },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: ID_COL, endIndex: ID_COL + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
      {
        setDataValidation: {
          range: cols(2, 3),
          rule: { condition: { type: 'ONE_OF_LIST', values: this.packages.map((userEnteredValue) => ({ userEnteredValue })) }, showCustomUi: true, strict: true },
        },
      },
      {
        setDataValidation: {
          range: cols(3, 4),
          rule: {
            condition: { type: 'ONE_OF_LIST', values: Array.from({ length: 11 }, (_, i) => ({ userEnteredValue: String(i + 1) })) },
            showCustomUi: true,
            strict: true,
          },
        },
      },
      ...STATUS_COLORS.map(([text, hex]) => ({
        addConditionalFormatRule: {
          rule: {
            ranges: [cols(5, 6)],
            booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] }, format: { backgroundColor: rgb(hex), textFormat: { bold: true } } },
          },
          index: 0,
        },
      })),
      // Правка колонок бота — с предупреждением: всё равно перезапишется.
      {
        addProtectedRange: {
          protectedRange: {
            range: cols(EDITABLE, COLS),
            description: 'Заполняет бот — ручные правки перезапишутся через минуту',
            warningOnly: true,
          },
        },
      },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: COLS } } } },
    ];
  }

  // Возвращает строки всех путей — из них же считается "Статистика".
  private async syncParents(sheetId: number, users: User[], upcoming: Upcoming[]): Promise<ParentRow[]> {
    const name = this.parentsSheetName;
    await this.ensureHeader(name, sheetId, PARENTS_COLUMNS.map((c) => c.title), () => this.parentsFormat(sheetId));

    const res = await this.sheets!.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${name}!A2:${LAST_COL}` });
    const sheetRows = (res.data.values ?? [])
      .map((cells, i) => ({ rowNumber: i + 2, cells: padRow(cells.map(String), COLS) }))
      .filter((r) => r.cells[ID_COL].trim());

    const userIds = new Set(users.map((u) => u.id));
    const lastAnswers = await this.lastAnswers();
    // upcoming отсортирован по времени — первое у родителя и есть ближайшее.
    const nextReminders = new Map<string, Date>();
    for (const u of upcoming) if (!nextReminders.has(u.user.id)) nextReminders.set(u.user.id, u.runAt);

    // Дубль строки (скопировали) и строки удалённых родителей — убираем.
    const byId = new Map<string, (typeof sheetRows)[number]>();
    const toDelete: number[] = [];
    for (const row of sheetRows) {
      const id = row.cells[ID_COL].trim();
      if (!userIds.has(id) || byId.has(id)) toDelete.push(row.rowNumber);
      else byId.set(id, row);
    }

    const updates: sheets_v4.Schema$ValueRange[] = [];
    const appends: string[][] = [];
    const result: ParentRow[] = [];

    for (let user of users) {
      const row = byId.get(user.id);

      if (row && user.sheetSyncHash && hashEditable(row.cells) !== user.sheetSyncHash) {
        const parsed = this.parseEditable(row.cells);
        if (parsed.ok) {
          user = await this.prisma.user.update({ where: { id: user.id }, data: parsed.fields });
          this.logger.log(`Строка родителя ${user.id} (tg ${user.tgId}) исправлена в таблице — применено в боте`);
        } else {
          this.logger.warn(`Строка родителя ${user.id}: ${parsed.error} — возвращаю прежнее значение`);
        }
      }

      const desired = this.parentRow(user, { last: lastAnswers.get(user.id), nextReminder: nextReminders.get(user.id) });
      result.push({ user, row: desired });
      if (!row) {
        if (user.sheetSyncHash) this.logger.log(`Строку родителя ${user.id} удалили из таблицы — возвращаю`);
        appends.push(desired);
      } else if (row.cells.some((c, i) => c !== desired[i])) {
        updates.push({ range: `${name}!A${row.rowNumber}:${LAST_COL}${row.rowNumber}`, values: [desired] });
      }

      const hash = hashEditable(desired);
      if (hash !== user.sheetSyncHash) {
        await this.prisma.user.update({ where: { id: user.id }, data: { sheetSyncHash: hash } });
      }
    }

    // Порядок важен: сначала правки по номерам строк, потом удаление снизу
    // вверх (номера выше не сдвигаются), потом новые строки в конец.
    if (updates.length) {
      await this.sheets!.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: updates },
      });
    }
    if (toDelete.length) {
      await this.sheets!.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [...toDelete]
            .sort((a, b) => b - a)
            .map((rowNumber) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } })),
        },
      });
    }
    if (appends.length) {
      await this.sheets!.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${name}!A:${LAST_COL}`,
        // Не INSERT_ROWS: вставленные строки берут оформление шапки, а не
        // колонок (телефон текстом, серый фон колонок бота).
        valueInputOption: 'RAW',
        requestBody: { values: appends },
      });
    }
    return result;
  }

  private parentRow(user: User, ctx: ParentRowContext): string[] {
    const vars = this.renderer.buildVars(user);
    const screen = this.scenario.hasScreen(user.stage) ? this.scenario.getScreen(user.stage) : undefined;
    const { status, why } = this.status(user, screen, vars, ctx);
    const lastSeen = user.lastTouchAt ?? ctx.last?.createdAt;
    return [
      user.name ?? '',
      user.phone ?? '',
      user.package ?? '',
      user.class ?? '',
      this.stepName(screen, vars),
      status,
      why,
      lastSeen ? moscowDateTime(lastSeen) : '',
      moscowDate(user.createdAt),
      user.isReturning == null ? '' : user.isReturning ? 'Продлевает' : 'Впервые',
      user.tgId.toString(),
      String(user.slot),
      user.stage,
      user.id,
    ];
  }

  private status(user: User, screen: Screen | undefined, vars: TemplateVars, ctx: ParentRowContext): { status: string; why: string } {
    const remind = ctx.nextReminder ? `бот напомнит ${moscowDayMonth(daytime(ctx.nextReminder))}` : '';

    if (ctx.last && isFrictionAnswer(ctx.last.value)) {
      const label = this.answerLabel(ctx.last.screenId, ctx.last.value, vars);
      return { status: STATUS.help, why: `Ответ «${label}» — ${moscowDateTime(ctx.last.createdAt)}. Стоит связаться и помочь.` };
    }
    if ((screen && user.mutedStages.includes(screen.stage)) || user.consecutiveMisses >= 3) {
      return { status: STATUS.silent, why: 'Нет ответа на 3 напоминания подряд — бот больше не напоминает про этот шаг. Стоит связаться.' };
    }
    if (user.deferredStage1) {
      const resume = user.resumePoint && this.scenario.hasScreen(user.resumePoint) ? this.scenario.getScreen(user.resumePoint) : undefined;
      const what = resume ? `«${this.stepName(resume, vars)}»` : 'первый шаг';
      return { status: STATUS.deferred, why: `Родитель отложил ${what}${remind ? `, ${remind}` : ''}.` };
    }
    if (!user.package || screen?.stage === 'start') {
      return { status: STATUS.notStarted, why: 'Знакомство с ботом: пакет и класс ещё не выбраны.' };
    }
    // Экран ожидания («загляну через неделю») — не вопрос, тогда только дата напоминания.
    const question = screen ? this.question(screen, vars, true) : '';
    const parts = [question ? `Бот спрашивает: «${question}»` : '', remind ? `${remind[0].toUpperCase()}${remind.slice(1)}` : ''];
    return { status: STATUS.ok, why: parts.filter(Boolean).join('. ') + (parts.some(Boolean) ? '.' : '') };
  }

  private parseEditable(cells: string[]): { ok: true; fields: Pick<User, 'name' | 'phone' | 'package' | 'class'> } | { ok: false; error: string } {
    const [name, phoneRaw, pkg, cls] = cells.slice(0, EDITABLE).map((c) => c.trim());
    if (pkg && !this.packages.includes(pkg)) return { ok: false, error: `неизвестный пакет "${pkg}"` };
    if (cls && !/^([1-9]|1[01])$/.test(cls)) return { ok: false, error: `класс "${cls}" не от 1 до 11` };
    // Тот же формат, что у телефона из бота: +7XXXXXXXXXX.
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return { ok: false, error: `телефон "${phoneRaw}" не похож на номер` };
    return { ok: true, fields: { name: name || null, phone, package: pkg || null, class: cls || null } };
  }

  // Последний ответ каждого родителя — одним запросом, без выгрузки всех ответов.
  private async lastAnswers(): Promise<Map<string, LastAnswer>> {
    const rows = await this.prisma.$queryRaw<Array<LastAnswer & { userId: string }>>`
      SELECT DISTINCT ON ("userId") "userId", "screenId", "value", "createdAt"
      FROM answers
      ORDER BY "userId", "createdAt" DESC`;
    return new Map(rows.map((r) => [r.userId, r]));
  }

  // Напоминания из очереди, которые правда придут, по времени: устаревшие
  // задачи (родитель ушёл с экрана, этап на паузе) воркер снимет при
  // наступлении срока — показывать их сотрудникам незачем.
  private async upcoming(users: User[]): Promise<Upcoming[]> {
    const byId = new Map(users.map((u) => [u.id, u]));
    const jobs = await this.prisma.job.findMany({
      where: { status: 'pending' },
      select: { userId: true, jobType: true, runAt: true },
      orderBy: { runAt: 'asc' },
    });
    const out: Upcoming[] = [];
    for (const job of jobs) {
      const user = byId.get(job.userId);
      if (!user) continue;
      const check = checkReminder(this.scenario, user, job.jobType);
      if (check.ok && !user.mutedStages.includes(check.stage)) {
        out.push({ user, jobType: job.jobType, runAt: job.runAt, reminder: check.reminder, source: check.source });
      }
    }
    return out;
  }

  // ─────────── Тексты из сценария ───────────

  // «Шаг 3 из 8 · Открепление». У стартовых экранов шага нет.
  private stepName(screen: Screen | undefined, vars: TemplateVars): string {
    if (!screen) return '';
    if (screen.stepLabel) return plain(renderTemplate(screen.stepLabel, vars));
    return screen.stage === 'start' ? 'Знакомство с ботом' : '';
  }

  // Вопрос экрана — последняя жирная фраза с «?», иначе (если не onlyQuestion)
  // первая строка текста.
  private question(screen: Screen, vars: TemplateVars, onlyQuestion = false): string {
    const text = renderTemplate(screen.text ?? '', vars);
    const bold = [...text.matchAll(/<b>([^<]*\?)\s*<\/b>/g)].map((m) => plain(m[1]));
    if (!bold.length && onlyQuestion) return '';
    const q = bold.length ? bold[bold.length - 1] : plain(text.split('\n')[0]);
    return q.length > 120 ? `${q.slice(0, 117)}...` : q;
  }

  // Суть экрана — первый абзац: у напоминаний там тема и срок («Промежуточная
  // аттестация — до 1 декабря…»), а вопрос в конце обычно общий («Как успехи?»).
  private gist(screen: Screen, vars: TemplateVars): string {
    const first = plain(renderTemplate(screen.text ?? '', vars).split(/\n\s*\n/)[0]);
    return first.length > 160 ? `${first.slice(0, 157)}...` : first;
  }

  // Подпись нажатой кнопки вместо кода; свободный ввод — как есть.
  private answerLabel(screenId: string, value: string, vars: TemplateVars): string {
    if (!this.scenario.hasScreen(screenId)) return value;
    const screen = this.scenario.getScreen(screenId);
    const button = [...(screen.buttons ?? []), screen.deferButton, screen.input?.skipButton].find((b) => b?.data === value);
    return button ? plain(renderTemplate(button.label, vars)) : value;
  }

  // ─────────── Ответы ───────────

  private answersFormat(sheetId: number): sheets_v4.Schema$Request[] {
    return [
      ...this.columnWidths(sheetId, ANSWERS_COLUMNS.map((c) => c.width)),
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1 },
          cell: { userEnteredFormat: { verticalAlignment: 'TOP', wrapStrategy: 'WRAP', textFormat: { bold: false }, backgroundColor: rgb('#ffffff') } },
          fields: 'userEnteredFormat(verticalAlignment,wrapStrategy,textFormat,backgroundColor)',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 7, endColumnIndex: 8 },
          cell: { userEnteredFormat: { textFormat: { foregroundColor: rgb('#9aa0a6'), fontSize: 9 } } },
          fields: 'userEnteredFormat.textFormat',
        },
      },
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: ANSWERS_COLUMNS.length }],
            booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$G2="да"' }] }, format: { backgroundColor: rgb('#fce8e6') } },
          },
          index: 0,
        },
      },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: ANSWERS_COLUMNS.length } } } },
    ];
  }

  // Журнал ответов — только дописывается (БД → таблица), ручные правки не
  // читаются: история неизменяема. Курсор — по времени последнего выгруженного
  // ответа, а не по числу строк: "газ с начала" удаляет ответы в БД, и курсор
  // по количеству строк разъехался бы.
  private async syncAnswers(sheetId: number): Promise<void> {
    const name = this.answersSheetName;
    const remade = await this.ensureHeader(name, sheetId, ANSWERS_COLUMNS.map((c) => c.title), () => this.answersFormat(sheetId));
    if (remade) {
      // Колонки поменялись — старые строки в другом формате, выгружаем журнал заново.
      await this.sheets!.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: `${name}!A2:Z` });
      await this.prisma.syncCursor.deleteMany({ where: { key: ANSWERS_CURSOR_KEY } });
    }

    const cursor = await this.prisma.syncCursor.findUnique({ where: { key: ANSWERS_CURSOR_KEY } });
    const since = cursor ? new Date(cursor.value) : new Date(0);
    const answers = await this.prisma.answer.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      take: 2000,
      include: { user: true },
    });
    if (!answers.length) return;

    const rows = answers.map((a) => {
      const vars = this.renderer.buildVars(a.user);
      const screen = this.scenario.hasScreen(a.screenId) ? this.scenario.getScreen(a.screenId) : undefined;
      return [
        moscowDateTime(a.createdAt),
        a.user.name ?? '',
        [a.user.package, a.user.class ? `${a.user.class} класс` : ''].filter(Boolean).join(', '),
        this.stepName(screen, vars),
        screen ? this.question(screen, vars) : a.screenId,
        this.answerLabel(a.screenId, a.value, vars),
        isFrictionAnswer(a.value) ? 'да' : '',
        a.user.tgId.toString(),
      ];
    });

    await this.sheets!.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${name}!A:${colLetter(ANSWERS_COLUMNS.length - 1)}`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    const last = answers[answers.length - 1].createdAt.toISOString();
    await this.prisma.syncCursor.upsert({
      where: { key: ANSWERS_CURSOR_KEY },
      create: { key: ANSWERS_CURSOR_KEY, value: last },
      update: { value: last },
    });
  }

  // ─────────── Напоминания ───────────

  // Отчёт, как "Статистика": вкладка целиком перезаписывается каждый тик.
  // Общие — календарь тарифов из сценария (at:), с числом родителей, которым
  // дата придёт. Персональные — относительные (через N дней после экрана),
  // каждое отдельной строкой, ближайшие сверху.
  private async syncReminders(sheetId: number, upcoming: Upcoming[]): Promise<void> {
    const now = new Date();
    const rows: Array<Array<string | number>> = [
      [`Обновлено: ${moscowDateTime(now)} · бот пишет с 10:00 до 21:00 МСК и не чаще раза в сутки — время ниже с учётом этого, сутки могут сдвинуть`],
      [''],
    ];
    const bold: number[] = [0];
    // Строки-заголовки — в одну строку поверх соседних ячеек, без переноса.
    const titles: number[] = [0];
    const grey: number[] = [];
    const section = (title: string, head: string[]) => {
      titles.push(rows.length);
      bold.push(rows.length, rows.length + 1);
      rows.push([title], head);
    };

    const willGet = new Map<string, number>();
    for (const u of upcoming) willGet.set(u.jobType, (willGet.get(u.jobType) ?? 0) + 1);

    const general = new Map<string, { at: string; tariff: string; about: string; count: number }>();
    for (const source of this.scenario.screens) {
      (source.reminders?.schedule ?? []).forEach((reminder, i) => {
        if (!reminder.at) return;
        // Тариф — по экрану напоминания: календарь может ставиться со
        // стартового экрана, общего для всех веток.
        const target = this.scenario.hasScreen(reminder.screen) ? this.scenario.getScreen(reminder.screen) : undefined;
        const stage = target?.stage ?? source.stage;
        const tariff = TARIFF_BY_STAGE.find(([re]) => re.test(stage))?.[1] ?? stage;
        const classes = reminder.forClass ? `${tariff.split(' · ')[0]} · ${reminder.forClass.join(', ')} класс` : tariff;
        const about = target ? this.gist(target, { grade11: reminder.forClass?.length === 1 && reminder.forClass[0] === '11' }) : reminder.screen;
        const key = `${reminder.at}\u0000${classes}\u0000${about}`;
        const row = general.get(key) ?? { at: reminder.at, tariff: classes, about, count: 0 };
        row.count += willGet.get(`${source.id}:${i}`) ?? 0;
        general.set(key, row);
      });
    }

    section('1. Общие — по календарю тарифа', ['Дата', 'Тариф', 'О чём напомнит', 'Получат (родителей)', 'Статус']);
    // Сначала предстоящие, прошедшие — серым в конце раздела.
    const dated = [...general.values()]
      .map((g) => ({ ...g, when: new Date(`${g.at}T10:00:00+03:00`) }))
      .sort((a, b) => a.at.localeCompare(b.at) || a.tariff.localeCompare(b.tariff, 'ru'));
    for (const past of [false, true]) {
      for (const g of dated.filter((d) => d.when < now === past)) {
        if (past) grey.push(rows.length);
        rows.push([moscowDate(g.when), g.tariff, g.about, g.count, past ? 'Прошло' : 'Впереди']);
      }
    }

    rows.push(['']);
    section('2. Персональные — после ответов родителя, ближайшие сверху', [
      'Когда',
      'Родитель',
      'О чём напомнит',
      'Почему',
      'Пакет, класс',
      'Сейчас на шаге',
      'Telegram ID',
    ]);
    const personal = upcoming.filter((u) => !u.reminder.at);
    if (!personal.length) rows.push(['Сейчас ничего не запланировано']);
    for (const u of personal.slice(0, PERSONAL_LIMIT)) {
      const vars = this.renderer.buildVars(u.user);
      const target = this.scenario.hasScreen(u.reminder.screen) ? this.scenario.getScreen(u.reminder.screen) : undefined;
      const current = this.scenario.hasScreen(u.user.stage) ? this.scenario.getScreen(u.user.stage) : undefined;
      const why = u.reminder.ifDeferred
        ? 'Родитель отложил первый шаг'
        : `Через ${daysText(u.reminder.afterHours ?? 0)} после «${this.gist(u.source, vars)}»${u.reminder.rearm ? ' — повторяет, пока нет ответа' : ''}`;
      rows.push([
        moscowDateTime(daytime(u.runAt)),
        u.user.name ?? '',
        target ? this.gist(target, vars) : u.reminder.screen,
        why,
        [u.user.package, u.user.class ? `${u.user.class} класс` : ''].filter(Boolean).join(', '),
        this.stepName(current, vars),
        u.user.tgId.toString(),
      ]);
    }
    if (personal.length > PERSONAL_LIMIT) rows.push([`…и ещё ${personal.length - PERSONAL_LIMIT}`]);

    await this.sheets!.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: this.remindersSheetName });
    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.remindersSheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    const row = (r: number) => ({ sheetId, startRowIndex: r, endRowIndex: r + 1 });
    await this.sheets!.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          ...this.columnWidths(sheetId, [140, 210, 340, 300, 170, 230, 110]),
          {
            repeatCell: {
              range: { sheetId },
              cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP', textFormat: { bold: false, foregroundColor: rgb('#000000') } } },
              fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,textFormat.bold,textFormat.foregroundColor)',
            },
          },
          ...bold.map((r) => ({ repeatCell: { range: row(r), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } })),
          ...titles.map((r) => ({ repeatCell: { range: row(r), cell: { userEnteredFormat: { wrapStrategy: 'OVERFLOW_CELL' } }, fields: 'userEnteredFormat.wrapStrategy' } })),
          ...grey.map((r) => ({
            repeatCell: { range: row(r), cell: { userEnteredFormat: { textFormat: { foregroundColor: rgb('#9aa0a6') } } }, fields: 'userEnteredFormat.textFormat.foregroundColor' },
          })),
          { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        ],
      },
    });
  }

  // ─────────── Статистика ───────────

  // Производный отчёт: вкладка целиком перезаписывается каждый тик. Всё
  // считает база (group by) — сколько бы ни накопилось ответов, в память
  // приходят сотни строк, а не все ответы.
  private async syncStats(sheetId: number, parents: ParentRow[]): Promise<void> {
    const byAnswer = await this.prisma.answer.groupBy({ by: ['screenId', 'value'], _count: { _all: true } });

    const statusCount = new Map<string, number>(STATUS_COLORS.map(([s]) => [s, 0]));
    const byStep = new Map<string, number>();
    for (const { user, row } of parents) {
      const status = row[5];
      statusCount.set(status, (statusCount.get(status) ?? 0) + 1);
      const pkg = [user.package ?? 'Пакет не выбран', user.class ? `${user.class} класс` : ''].filter(Boolean).join(', ');
      const key = `${pkg}\u0000${row[4] || user.stage}`;
      byStep.set(key, (byStep.get(key) ?? 0) + 1);
    }

    const questions = new Map<string, { total: number; friction: number }>();
    for (const g of byAnswer) {
      const q = questions.get(g.screenId) ?? { total: 0, friction: 0 };
      q.total += g._count._all;
      if (isFrictionAnswer(g.value)) q.friction += g._count._all;
      questions.set(g.screenId, q);
    }

    const total = parents.length;
    const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%');
    // Счётчики — числами, а не строками: иначе диаграмма их не нарисует.
    const rows: Array<Array<string | number>> = [[`Обновлено: ${moscowDateTime(new Date())} · всего путей: ${total}`], ['']];
    // Номера строк заголовков разделов и шапок таблиц — для жирного шрифта.
    const bold: number[] = [0];
    const section = (title: string, head: string[]) => {
      bold.push(rows.length, rows.length + 1);
      rows.push([title], head);
    };

    section('1. Статусы', ['Статус', 'Сколько', '% от всех']);
    const statusStart = rows.length;
    for (const [s, n] of statusCount) rows.push([s, n, pct(n, total)]);
    const statusEnd = rows.length;

    rows.push(['']);
    section('2. Где сейчас родители', ['Пакет, класс', 'Шаг', 'Сколько']);
    const stepNumber = (s: string) => Number(s.match(/Шаг (\d+)/)?.[1] ?? 0);
    [...byStep.entries()]
      .map(([key, n]) => [...key.split('\u0000'), n] as [string, string, number])
      .sort((a, b) => a[0].localeCompare(b[0], 'ru') || stepNumber(a[1]) - stepNumber(b[1]))
      .forEach(([pkg, step, n]) => rows.push([pkg, step, n]));

    rows.push(['']);
    section('3. Где чаще всего затрудняются', ['Вопрос бота', 'Шаг', 'Затруднений / ответов', '% затруднений']);
    [...questions.entries()]
      .filter(([, v]) => v.friction > 0)
      .sort((a, b) => b[1].friction / b[1].total - a[1].friction / a[1].total || b[1].friction - a[1].friction)
      .slice(0, 30)
      .forEach(([screenId, v]) => {
        const screen = this.scenario.hasScreen(screenId) ? this.scenario.getScreen(screenId) : undefined;
        rows.push([screen ? this.question(screen, {}) : screenId, this.stepName(screen, {}), `${v.friction} / ${v.total}`, pct(v.friction, v.total)]);
      });

    // clear() трогает только значения — диаграмма остаётся и обновляется на месте.
    await this.sheets!.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: this.statsSheetName });
    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.statsSheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    await this.ensureStatsLayout(sheetId, statusStart, statusEnd, bold);
  }

  // Ширина колонок и диаграмма статусов — один раз; дальше только диапазон
  // диаграммы и жирные строки (их номера меняются вместе с отчётом).
  // Диаграмму ищем по заголовку, иначе копились бы дубли.
  private async ensureStatsLayout(sheetId: number, dataStart: number, dataEnd: number, boldRows: number[]): Promise<void> {
    const title = 'Статусы родителей';
    const spec: sheets_v4.Schema$ChartSpec = {
      title,
      basicChart: {
        chartType: 'BAR',
        legendPosition: 'NO_LEGEND',
        axis: [{ position: 'BOTTOM_AXIS', title: 'Родителей' }],
        domains: [{ domain: { sourceRange: { sources: [{ sheetId, startRowIndex: dataStart, endRowIndex: dataEnd, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
        series: [
          {
            series: { sourceRange: { sources: [{ sheetId, startRowIndex: dataStart, endRowIndex: dataEnd, startColumnIndex: 1, endColumnIndex: 2 }] } },
            targetAxis: 'BOTTOM_AXIS',
          },
        ],
      },
    };

    const meta = await this.sheets!.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      ranges: [this.statsSheetName],
      fields: 'sheets(charts(chartId,spec.title))',
    });
    const charts = meta.data.sheets?.[0]?.charts ?? [];
    const existing = charts.find((c) => c.spec?.title === title);
    const requests: sheets_v4.Schema$Request[] = [
      ...charts.filter((c) => c.spec?.title !== title).map((c) => ({ deleteEmbeddedObject: { objectId: c.chartId! } })),
      { repeatCell: { range: { sheetId }, cell: { userEnteredFormat: { textFormat: { bold: false } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      ...boldRows.map((row) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: row, endRowIndex: row + 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      })),
    ];

    if (existing) {
      requests.push({ updateChartSpec: { chartId: existing.chartId!, spec } });
    } else {
      requests.push(
        ...this.columnWidths(sheetId, [340, 230, 160, 120]),
        { repeatCell: { range: { sheetId }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } },
        {
          addChart: {
            chart: { spec, position: { overlayPosition: { anchorCell: { sheetId, rowIndex: 0, columnIndex: 5 }, widthPixels: 520, heightPixels: 280 } } },
          },
        },
      );
    }
    await this.sheets!.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
  }

  // ─────────── Как читать ───────────

  private async syncGuide(sheetId: number): Promise<void> {
    const marker = `Как читать эту таблицу (${GUIDE_VERSION})`;
    const res = await this.sheets!.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${this.guideSheetName}!A1` });
    if (res.data.values?.[0]?.[0] === marker) return;

    const p = this.parentsSheetName;
    const rows: string[][] = [
      [marker, ''],
      ['Таблицу заполняет бот «Зачисление в школу», обновляется раз в минуту.', ''],
      [''],
      ['Вкладки', ''],
      [p, 'Один родитель (герой) — одна строка: на каком шаге, всё ли в порядке, что сделать.'],
      [this.answersSheetName, 'Журнал: кто, когда, на какой вопрос бота что ответил. Красным — затруднения.'],
      [
        this.remindersSheetName,
        'Что бот напишет сам. Общие — даты календаря тарифа и сколько родителей их получат. Персональные — «через N дней после ответа», кому и когда.',
      ],
      [this.statsSheetName, 'Сводка: сколько родителей в каждом статусе, на каких шагах, где чаще всего затрудняются.'],
      [''],
      ['Статусы', ''],
      [STATUS.help, 'Последний ответ родителя — «не получается»: пусто, не подходит пароль, не нашёл, нет документа, незачёт. Стоит связаться.'],
      [STATUS.silent, 'Нет ответа на 3 напоминания подряд — бот перестал напоминать про этот шаг. Стоит связаться.'],
      [STATUS.deferred, 'Родитель сам попросил отложить первый шаг. Бот напомнит — дата в колонке «Что происходит».'],
      [STATUS.notStarted, 'Бот запущен, но пакет и класс ещё не выбраны.'],
      [STATUS.ok, 'Всё идёт своим ходом. В «Что происходит» — какой вопрос бот задал и когда напомнит.'],
      [''],
      ['Что можно править', ''],
      ['Имя, телефон, пакет, класс', `Белые колонки на вкладке «${p}». Правка уходит в бота через минуту. Пакет и класс — из списка.`],
      ['Остальные колонки', 'Серые, их заполняет бот. Ручная правка перезапишется через минуту.'],
      ['Удаление строки', 'Строка вернётся через минуту. Удалить родителя из бота можно только из самого бота.'],
      ['Сортировка и фильтры', 'Можно сортировать и фильтровать как угодно — бот находит строки по скрытому id.'],
    ];
    await this.sheets!.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: this.guideSheetName });
    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.guideSheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    const bold = (row: number) => ({
      repeatCell: { range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } }, fields: 'userEnteredFormat.textFormat' },
    });
    const statusRows = STATUS_COLORS.map(([text, hex]) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: rows.findIndex((r) => r[0] === text), endRowIndex: rows.findIndex((r) => r[0] === text) + 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: rgb(hex), textFormat: { bold: true } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    }));
    await this.sheets!.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          ...this.columnWidths(sheetId, [230, 620]),
          // Сначала сброс: строки прошлой версии стояли на других местах.
          {
            repeatCell: {
              range: { sheetId },
              cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP', backgroundColor: rgb('#ffffff'), textFormat: { bold: false, fontSize: 10 } } },
              fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,backgroundColor,textFormat)',
            },
          },
          { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }, fields: 'userEnteredFormat.textFormat' } },
          ...['Вкладки', 'Статусы', 'Что можно править'].map((title) => bold(rows.findIndex((r) => r[0] === title))),
          ...statusRows,
        ],
      },
    });
  }
}
