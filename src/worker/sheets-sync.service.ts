import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { isFrictionAnswer } from './friction.util';

// ⚠️ ВРЕМЕННО, ТОЛЬКО ДЛЯ ТЕСТОВОГО БОТА.
//
// По docs/spec.md (раздел 8) выгрузка в Google Sheets должна быть
// односторонней (БД → таблица), раз в сутки, и содержать только
// client_code — без имени и телефона (п.5 CLAUDE.md, «персональные данные
// не покидают БД»). Этот сервис по прямой просьбе заказчика на время
// тестирования делает больше: двустороннюю синхронизацию всех полей,
// с полными персональными данными в корпоративной таблице с ограниченным
// доступом. Прежде чем переходить в прод — вернуться к разделу 8 спеки.
//
// Разрешение конфликта "кто правил последним": для каждого пользователя
// храним sheetSyncHash — хеш бизнес-полей на момент последней синхронизации.
//   - хеш строки в таблице совпадает с sheetSyncHash → таблицу с тех пор не
//     трогали руками → если БД изменилась (диалог бота) — перезаписываем строку.
//   - хеш строки в таблице НЕ совпадает → её правили руками → тянем в БД.
// Если оба источника разошлись за один тик (человек и родитель одновременно) —
// побеждает правка в таблице. Для тестового инструмента это приемлемо.
//
// Удаление строки в таблице = удаление пользователя (как S1a «Удалить мои
// данные») — только для строк, которые уже были синхронизированы хотя бы раз
// (иначе только что созданный, ещё не выгруженный пользователь удалился бы
// на первом же тике).

type EditableFields = {
  clientCode: string | null;
  name: string | null;
  phone: string | null;
  package: string | null;
  class: string | null;
  isReturning: boolean | null;
  stage: string;
  cohortYear: number | null;
  deferredStage1: boolean;
  resumePoint: string | null;
  consentAt: Date | null;
  consecutiveMisses: number;
  mutedStages: string[];
};

// Порядок строго соответствует столбцам A.. в таблице — см. HEADER ниже.
const HEADER = [
  'id (не редактировать)',
  'tgId',
  'clientCode',
  'name',
  'phone',
  'package',
  'class',
  'isReturning',
  'stage',
  'cohortYear',
  'deferredStage1',
  'resumePoint',
  'consentAt',
  'consecutiveMisses',
  'mutedStages (через запятую)',
];
const SHEET_RANGE_ALL = 'A2:O';
const SHEET_HEADER_RANGE = 'A1:O1';
// Справочная колонка со человекочитаемой расшифровкой stage — на одну
// колонку правее последней рабочей (O), никогда не читается синхронизацией.
const LABEL_COLUMN = 'P';
const LABEL_COLUMN_HEADER = 'Экран — о чём он (только для чтения, не редактировать)';

// Хеш считается ОДНИМ И ТЕМ ЖЕ способом — от канонического массива строк
// (13 бизнес-столбцов, без id/tgId), а не от JS-объекта. Иначе хеш строки
// из таблицы (массив строк) никогда не совпадёт с хешем полей из БД
// (объект) даже при полностью идентичных значениях — и синхронизация будет
// гонять одни и те же данные туда-сюда на каждом тике, принимая их за
// ручную правку.
const BUSINESS_COLUMNS = 13;

function padCells(cells: string[]): string[] {
  const out = cells.slice(0, BUSINESS_COLUMNS);
  while (out.length < BUSINESS_COLUMNS) out.push('');
  return out;
}

function hashCells(cells: string[]): string {
  return createHash('sha1').update(JSON.stringify(padCells(cells))).digest('hex');
}

function toCell(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

function parseBool(v: string): boolean | null {
  const t = v.trim().toUpperCase();
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  return null;
}

const ANSWERS_HEADER = ['Дата и время', 'Родитель (tg_id)', 'Экран', 'О чём экран', 'Ответ / что написал', 'Проблема?'];
const ANSWERS_CURSOR_KEY = 'answers_sheet';
const STATS_SHEET_NAME_DEFAULT = 'Статистика';

function formatMoscowTime(d: Date): string {
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
}

// Первая строка экрана — короткий, человекочитаемый контекст рядом с
// техническим screen_id, чтобы не приходилось помнить, что такое
// "e2_2a_missing". Шаблонные {{...}} и HTML-разметку (<b>...</b>) вырезаем —
// движковую разметку читать незачем.
function screenGist(text: string): string {
  const firstLine = text.split('\n')[0];
  const plain = firstLine.replace(/\{\{[^}]*\}\}/g, '').replace(/<[^>]+>/g, '').trim();
  return plain.length > 70 ? `${plain.slice(0, 67)}...` : plain;
}

// Человекочитаемая расшифровка stage-кода — только для чтения, нигде не
// парсится обратно. Используется и в справочной колонке листа пользователей,
// и на вкладке "Статистика". Экран мог исчезнуть из текущей версии сценария
// (правки после того, как строка синхронизировалась) — тогда просто голый id.
function makeScreenLabel(scenario: ScenarioService): (screenId: string) => string {
  return (screenId: string): string => {
    if (!screenId) return '';
    try {
      return `${screenId} — ${screenGist(scenario.getScreen(screenId).text)}`;
    } catch {
      return screenId;
    }
  };
}

@Injectable()
export class SheetsSyncService implements OnModuleInit {
  private readonly logger = new Logger(SheetsSyncService.name);
  private sheets: sheets_v4.Sheets | null = null;
  private spreadsheetId = '';
  private sheetName = 'Users';
  private answersSheetName = 'Ответы';
  private statsSheetName = STATS_SHEET_NAME_DEFAULT;
  private enabled = false;
  // Заполняется в onModuleInit, когда this.scenario уже доступен — обычной
  // стрелочной функции с this в конструкторе тут не получится.
  private screenLabel: (screenId: string) => string = (id) => id;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
  ) {}

  onModuleInit(): void {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? '';
    this.sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Users';
    this.answersSheetName = process.env.GOOGLE_SHEETS_ANSWERS_SHEET_NAME ?? 'Ответы';
    this.statsSheetName = process.env.GOOGLE_SHEETS_STATS_SHEET_NAME ?? STATS_SHEET_NAME_DEFAULT;
    const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!this.spreadsheetId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Sheets-синхронизация выключена: не заданы GOOGLE_SHEETS_SPREADSHEET_ID / _CLIENT_EMAIL / _PRIVATE_KEY в .env',
      );
      return;
    }

    const auth = new JWT({ email: clientEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.screenLabel = makeScreenLabel(this.scenario);
    this.enabled = true;
    this.logger.log(
      `Sheets-синхронизация включена: таблица ${this.spreadsheetId}, лист "${this.sheetName}" + лог ответов "${this.answersSheetName}"`,
    );
  }

  async syncOnce(): Promise<void> {
    if (!this.enabled || !this.sheets) return;

    try {
      await this.ensureHeader();
      const sheetRows = await this.readSheetRows();
      const dbUsers = await this.prisma.user.findMany();

      const sheetById = new Map(sheetRows.map((r) => [r.id, r]));
      const dbById = new Map(dbUsers.map((u) => [u.id, u]));

      // 1) Строки, которые пропали из таблицы, но были синхронизированы раньше — удаление.
      for (const user of dbUsers) {
        if (user.sheetSyncHash && !sheetById.has(user.id)) {
          this.logger.log(`Строка ${user.id} (tg ${user.tgId}) удалена из таблицы вручную — удаляю пользователя из БД`);
          await this.prisma.user.delete({ where: { id: user.id } }).catch((err) => {
            this.logger.warn(`Не удалось удалить ${user.id}: ${err}`);
          });
        }
      }

      // 2) Остальные — по каждому решаем, чья версия свежее.
      for (const user of dbUsers) {
        const row = sheetById.get(user.id);
        const dbFields = this.pickEditable(user);
        const dbHash = this.hashOfEditable(dbFields);

        if (!row) {
          await this.appendRow(user.id, user.tgId.toString(), dbFields);
          await this.prisma.user.update({ where: { id: user.id }, data: { sheetSyncHash: dbHash } });
          continue;
        }

        if (row.hash === user.sheetSyncHash) {
          // Таблицу с последнего раза не трогали — если БД изменилась, обновляем строку.
          if (dbHash !== user.sheetSyncHash) {
            await this.writeRow(row.rowNumber, user.id, user.tgId.toString(), dbFields);
            await this.prisma.user.update({ where: { id: user.id }, data: { sheetSyncHash: dbHash } });
          }
          continue;
        }

        // Строку правили руками — пробуем применить в БД.
        const parsed = this.parseRow(row);
        if (!parsed.ok) {
          this.logger.warn(`Строка ${user.id}: ${parsed.error} — откатываю правку, возвращаю значения из БД`);
          await this.writeRow(row.rowNumber, user.id, user.tgId.toString(), dbFields);
          await this.prisma.user.update({ where: { id: user.id }, data: { sheetSyncHash: dbHash } });
          continue;
        }

        const newHash = this.hashOfEditable(parsed.fields);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { ...parsed.fields, sheetSyncHash: newHash },
        });
        // Перезаписываем строку канонической формой (нормализованные даты и т.п.).
        await this.writeRow(row.rowNumber, user.id, user.tgId.toString(), parsed.fields);
        this.logger.log(`Строка ${user.id} (tg ${user.tgId}) обновлена вручную из таблицы, применено в БД`);
      }

      await this.syncAnswers();
      await this.syncStats();
    } catch (err) {
      this.logger.error(`Ошибка синхронизации с Google Sheets: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Лог "Затруднений" (раздел 8 спеки) — каждый ответ/ввод родителя, уже
  // пишется движком в answers. Здесь только выгружаем накопленное в
  // отдельную вкладку таблицы, в человекочитаемом виде: не только
  // screen_id, но и о чём экран, плюс отдельная колонка-флаг "Проблема?" —
  // чтобы можно было отфильтровать/отсортировать по ней визуально, не считая
  // руками. Односторонняя выгрузка (БД → таблица), правка руками не
  // читается обратно — история ответов неизменяема по своей природе.
  //
  // Курсор — по времени (`SyncCursor`), а не по числу строк: "газ с начала"
  // удаляет пользователей и answers в БД, но не трогает уже выгруженную
  // историю в таблице — курсор по количеству строк из-за этого разъехался
  // бы и синхронизация замерла бы до следующего накопления пользователей.
  private async syncAnswers(): Promise<void> {
    await this.ensureSheetTab(this.answersSheetName, ANSWERS_HEADER);

    const cursor = await this.prisma.syncCursor.findUnique({ where: { key: ANSWERS_CURSOR_KEY } });
    const since = cursor ? new Date(cursor.value) : new Date(0);

    const newAnswers = await this.prisma.answer.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { tgId: true } } },
    });

    if (newAnswers.length === 0) return;

    const rows = newAnswers.map((a) => {
      let gist = '';
      try {
        gist = screenGist(this.scenario.getScreen(a.screenId).text);
      } catch {
        // Экран мог исчезнуть из текущей версии сценария — не критично, просто без описания.
      }
      return [
        formatMoscowTime(a.createdAt),
        a.user.tgId.toString(),
        a.screenId,
        gist,
        a.value,
        isFrictionAnswer(a.value) ? 'да' : '',
      ];
    });

    await this.sheets!.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.answersSheetName}!A:F`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    const lastCreatedAt = newAnswers[newAnswers.length - 1].createdAt.toISOString();
    await this.prisma.syncCursor.upsert({
      where: { key: ANSWERS_CURSOR_KEY },
      create: { key: ANSWERS_CURSOR_KEY, value: lastCreatedAt },
      update: { value: lastCreatedAt },
    });
  }

  // Сводка "где чаще всего тормозят" прямо в таблице — раньше это было видно
  // только через `npm run stats` в консоли. Вкладка целиком перезаписывается
  // на каждом тике (это производный отчёт, не место для ручных правок).
  private async syncStats(): Promise<void> {
    const sheetId = await this.ensureSheetTab(this.statsSheetName, ['Статистика по боту — обновляется автоматически']);

    const totalUsers = await this.prisma.user.count();
    const byStage = await this.prisma.user.groupBy({ by: ['stage'], _count: { _all: true } });
    const answers = await this.prisma.answer.findMany({ select: { screenId: true, value: true } });

    const traffic = new Map<string, number>();
    const friction = new Map<string, { total: number; friction: number }>();
    for (const a of answers) {
      traffic.set(a.screenId, (traffic.get(a.screenId) ?? 0) + 1);
      const f = friction.get(a.screenId) ?? { total: 0, friction: 0 };
      f.total += 1;
      if (isFrictionAnswer(a.value)) f.friction += 1;
      friction.set(a.screenId, f);
    }

    // Колонка A везде — короткий screen_id: это и есть подпись графика, длинную
    // расшифровку туда сажать нельзя (подписи под столбцами станут нечитаемы).
    // Описание — отдельной колонкой B, для человека, не для графика.
    const rows: string[][] = [
      [`Обновлено: ${formatMoscowTime(new Date())}`],
      [''],
      [`1. Где сейчас стоят родители (всего: ${totalUsers})`],
      ['Экран', 'Описание', 'Сейчас на нём', '% от всех'],
    ];
    const sortedByStage = [...byStage].sort((a, b) => b._count._all - a._count._all);
    // Диапазон нужен графику ниже — считаем его тут же, а не пересчитываем
    // вручную по номерам строк (сдвинулись бы при любой правке текста выше).
    const byStageStartRow = rows.length; // 0-индексация Sheets API
    for (const r of sortedByStage) {
      rows.push([r.stage, this.screenLabel(r.stage), String(r._count._all), totalUsers ? `${Math.round((r._count._all / totalUsers) * 100)}%` : '0%']);
    }
    const byStageEndRow = rows.length; // конец диапазона исключительно (endRowIndex)

    rows.push(
      [''],
      ['2. Трафик по экранам (сколько раз вообще отвечали)'],
      ['Экран', 'Описание', 'Ответов', ''],
      ...[...traffic.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([screenId, count]) => [screenId, this.screenLabel(screenId), String(count), '']),
      [''],
      ['3. Проблемные экраны (доля ответов "Нет / Не получается / не понял / в КС")'],
      ['Экран', 'Описание', 'Проблемных / всего', '% проблемных'],
      ...[...friction.entries()]
        .filter(([, v]) => v.friction > 0)
        .sort((a, b) => b[1].friction / b[1].total - a[1].friction / a[1].total)
        .map(([screenId, v]) => [screenId, this.screenLabel(screenId), `${v.friction}/${v.total}`, `${Math.round((v.friction / v.total) * 100)}%`]),
    );

    // Сначала чистим весь лист — иначе при уменьшении отчёта (например, после
    // "газ с начала") снизу остались бы старые строки от прошлого прогона.
    // clear() трогает только значения ячеек — встроенные графики остаются
    // на месте, поэтому график ниже обновляется в ту же диаграмму, а не
    // плодит новую на каждом тике.
    await this.sheets!.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: this.statsSheetName });
    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.statsSheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    if (sheetId != null) {
      await this.sheets!.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 4 } } }],
        },
      });
      await this.ensureStatsChart(sheetId, byStageStartRow, byStageEndRow);
    }
  }

  // Столбчатая диаграмма "где сейчас родители" — чтобы распределение было
  // видно сразу, без чтения таблицы построчно. Идемпотентно: ищет диаграмму
  // с тем же заголовком в метаданных листа и обновляет её диапазон (данные
  // каждый тик пересчитываются, число активных экранов может меняться), а
  // не добавляет новую — иначе на вкладке копились бы дубли раз в минуту.
  private async ensureStatsChart(sheetId: number, dataStartRow: number, dataEndRow: number): Promise<void> {
    // Пустая группировка (например, сразу после "газ с начала", пока никто
    // не написал боту) — графику нечего показывать, тихо выходим.
    if (dataEndRow <= dataStartRow) return;

    const chartTitle = 'Где сейчас родители (по экранам)';
    const spec: sheets_v4.Schema$ChartSpec = {
      title: chartTitle,
      basicChart: {
        chartType: 'COLUMN',
        legendPosition: 'NO_LEGEND',
        headerCount: 0,
        axis: [
          { position: 'BOTTOM_AXIS', title: 'Экран' },
          { position: 'LEFT_AXIS', title: 'Родителей' },
        ],
        domains: [
          {
            domain: {
              sourceRange: {
                sources: [{ sheetId, startRowIndex: dataStartRow, endRowIndex: dataEndRow, startColumnIndex: 0, endColumnIndex: 1 }],
              },
            },
          },
        ],
        series: [
          {
            series: {
              sourceRange: {
                sources: [{ sheetId, startRowIndex: dataStartRow, endRowIndex: dataEndRow, startColumnIndex: 2, endColumnIndex: 3 }],
              },
            },
            targetAxis: 'LEFT_AXIS',
          },
        ],
      },
    };

    const meta = await this.sheets!.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      ranges: [this.statsSheetName],
      fields: 'sheets(charts(chartId,spec.title))',
    });
    const existingChartId = meta.data.sheets?.[0]?.charts?.find((c) => c.spec?.title === chartTitle)?.chartId;

    await this.sheets!.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          existingChartId != null
            ? { updateChartSpec: { chartId: existingChartId, spec } }
            : {
                addChart: {
                  chart: {
                    spec,
                    position: {
                      overlayPosition: {
                        anchorCell: { sheetId, rowIndex: 0, columnIndex: 5 },
                        widthPixels: 640,
                        heightPixels: 360,
                      },
                    },
                  },
                },
              },
        ],
      },
    });
  }

  // Создаёт вкладку в таблице, если её ещё нет, пишет заголовок в пустую
  // вкладку и один раз применяет базовое форматирование (жирная закреплённая
  // шапка, авто-ширина колонок) — чтобы вкладку было легко читать визуально,
  // а не только парсить программно. Возвращает числовой sheetId вкладки.
  private async ensureSheetTab(name: string, header: string[]): Promise<number | undefined> {
    const meta = await this.sheets!.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    let sheetId = meta.data.sheets?.find((s) => s.properties?.title === name)?.properties?.sheetId ?? undefined;

    if (sheetId == null) {
      const created = await this.sheets!.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
      });
      sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
    }

    const lastCol = String.fromCharCode('A'.charCodeAt(0) + header.length - 1);
    const res = await this.sheets!.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${name}!A1:${lastCol}1`,
    });
    const headerWasMissing = !res.data.values?.length;
    if (headerWasMissing) {
      await this.sheets!.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${name}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [header] },
      });

      if (sheetId != null) {
        await this.sheets!.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
              {
                repeatCell: {
                  range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                  cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.92, blue: 0.96 } } },
                  fields: 'userEnteredFormat(textFormat,backgroundColor)',
                },
              },
              { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: header.length } } },
            ],
          },
        });
      }
    }

    return sheetId;
  }

  // Хеш бизнес-полей из БД — в ТОМ ЖЕ каноническом виде (массив строк),
  // что и хеш строки таблицы, иначе они несравнимы (см. комментарий у hashCells).
  private hashOfEditable(f: EditableFields): string {
    return hashCells(this.rowValues('', '', f).slice(2));
  }

  private pickEditable(user: {
    clientCode: string | null;
    name: string | null;
    phone: string | null;
    package: string | null;
    class: string | null;
    isReturning: boolean | null;
    stage: string;
    cohortYear: number | null;
    deferredStage1: boolean;
    resumePoint: string | null;
    consentAt: Date | null;
    consecutiveMisses: number;
    mutedStages: string[];
  }): EditableFields {
    return {
      clientCode: user.clientCode,
      name: user.name,
      phone: user.phone,
      package: user.package,
      class: user.class,
      isReturning: user.isReturning,
      stage: user.stage,
      cohortYear: user.cohortYear,
      deferredStage1: user.deferredStage1,
      resumePoint: user.resumePoint,
      consentAt: user.consentAt,
      consecutiveMisses: user.consecutiveMisses,
      mutedStages: user.mutedStages,
    };
  }

  private async ensureHeader(): Promise<void> {
    const res = await this.sheets!.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!${SHEET_HEADER_RANGE}`,
    });
    if (!res.data.values?.length) {
      await this.sheets!.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!${SHEET_HEADER_RANGE}`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
      });
    }
    // Справочная колонка P — намеренно ВНЕ HEADER/SHEET_RANGE_ALL: она не
    // читается обратно в readSheetRows/parseRow и не входит в hashOfCells,
    // поэтому не может повлиять на двустороннюю синхронизацию, даже если
    // кто-то впишет в неё что-то руками. Только расшифровка stage для чтения.
    const labelHeader = await this.sheets!.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!${LABEL_COLUMN}1`,
    });
    if (!labelHeader.data.values?.length) {
      await this.sheets!.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!${LABEL_COLUMN}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [[LABEL_COLUMN_HEADER]] },
      });
    }
  }

  // Не часть round-trip: отдельный вызов после appendRow/writeRow, только
  // для удобства чтения человеком. rowNumber всегда известен вызывающей
  // стороне (append — из ответа API, write — уже был известен заранее).
  private async writeLabelCell(rowNumber: number, stage: string): Promise<void> {
    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!${LABEL_COLUMN}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[this.screenLabel(stage)]] },
    });
  }

  private async readSheetRows(): Promise<Array<{ id: string; rowNumber: number; tgId: string; cells: string[]; hash: string }>> {
    const res = await this.sheets!.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!${SHEET_RANGE_ALL}`,
    });
    const rows = res.data.values ?? [];
    return rows
      .map((cells, i) => ({ id: (cells[0] ?? '').trim(), rowNumber: i + 2, tgId: cells[1] ?? '', cells, hash: '' }))
      .filter((r) => r.id.length > 0)
      .map((r) => ({ ...r, hash: this.hashOfCells(r.cells) }));
  }

  // Хеш видимых бизнес-полей строки (без id/tgId — они не редактируются).
  private hashOfCells(cells: string[]): string {
    return hashCells(cells.slice(2, 15));
  }

  // Индексы строго по HEADER: 0=id, 1=tgId, дальше бизнес-поля с 2 по 14.
  private parseRow(row: { cells: string[] }): { ok: true; fields: EditableFields } | { ok: false; error: string } {
    const c = row.cells;
    const stage = (c[8] ?? '').trim();
    if (!stage || !this.scenario.hasScreen(stage)) {
      return { ok: false, error: `недопустимый stage "${stage}"` };
    }
    const resumePoint = (c[11] ?? '').trim() || null;
    if (resumePoint && !this.scenario.hasScreen(resumePoint)) {
      return { ok: false, error: `недопустимый resumePoint "${resumePoint}"` };
    }
    const cohortYearRaw = (c[9] ?? '').trim();
    const cohortYear = cohortYearRaw ? Number(cohortYearRaw) : null;
    if (cohortYearRaw && Number.isNaN(cohortYear)) {
      return { ok: false, error: `нечисловой cohortYear "${cohortYearRaw}"` };
    }
    const consecutiveMissesRaw = (c[13] ?? '').trim();
    const consecutiveMisses = consecutiveMissesRaw ? Number(consecutiveMissesRaw) : 0;
    if (Number.isNaN(consecutiveMisses)) {
      return { ok: false, error: `нечисловой consecutiveMisses "${consecutiveMissesRaw}"` };
    }
    const consentAtRaw = (c[12] ?? '').trim();
    const consentAt = consentAtRaw ? new Date(consentAtRaw) : null;
    if (consentAtRaw && Number.isNaN(consentAt?.getTime())) {
      return { ok: false, error: `нечитаемая дата consentAt "${consentAtRaw}"` };
    }

    return {
      ok: true,
      fields: {
        clientCode: (c[2] ?? '').trim() || null,
        name: (c[3] ?? '').trim() || null,
        phone: (c[4] ?? '').trim() || null,
        package: (c[5] ?? '').trim() || null,
        class: (c[6] ?? '').trim() || null,
        isReturning: parseBool(c[7] ?? ''),
        stage,
        cohortYear,
        deferredStage1: parseBool(c[10] ?? '') ?? false,
        resumePoint,
        consentAt,
        consecutiveMisses,
        mutedStages: (c[14] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };
  }

  private rowValues(id: string, tgId: string, f: EditableFields): string[] {
    return [
      id,
      tgId,
      toCell(f.clientCode),
      toCell(f.name),
      toCell(f.phone),
      toCell(f.package),
      toCell(f.class),
      toCell(f.isReturning),
      toCell(f.stage),
      toCell(f.cohortYear),
      toCell(f.deferredStage1),
      toCell(f.resumePoint),
      toCell(f.consentAt),
      toCell(f.consecutiveMisses),
      toCell(f.mutedStages),
    ];
  }

  private async appendRow(id: string, tgId: string, f: EditableFields): Promise<void> {
    const res = await this.sheets!.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A:O`,
      valueInputOption: 'RAW',
      requestBody: { values: [this.rowValues(id, tgId, f)] },
    });
    // updatedRange выглядит как "Users!A5:O5" — оттуда достаём номер строки,
    // чтобы поставить расшифровку в ту же строку колонки P.
    const match = res.data.updates?.updatedRange?.match(/(\d+):/);
    if (match) await this.writeLabelCell(Number(match[1]), f.stage);
  }

  private async writeRow(rowNumber: number, id: string, tgId: string, f: EditableFields): Promise<void> {
    await this.sheets!.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A${rowNumber}:O${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [this.rowValues(id, tgId, f)] },
    });
    await this.writeLabelCell(rowNumber, f.stage);
  }
}
