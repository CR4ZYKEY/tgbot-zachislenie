// Разовый админ-скрипт (часть «газ с начала»): очищает Google-таблицу бота.
//   "Родители"   — строки данных; шапка и оформление колонок остаются.
//   "Ответы"     — целиком вместе с шапкой: воркер на следующем тике
//                  создаст шапку и оформление заново, без следов старых строк.
//   "Напоминания", "Статистика" — целиком, пересчитаются на следующем тике.
//   "Как читать" — не трогаем.
// Плюс сбрасывает курсор выгрузки ответов в БД — иначе воркер решит, что
// уже всё выгрузил (курсор по времени последнего ответа), и не покажет
// свежие ответы, пока их createdAt не перегонит старый курсор.
//
// Запускать ТОЛЬКО при остановленном воркере или вместе с очисткой БД:
// строки родителей, которые остались в БД, воркер просто вернёт.
import 'dotenv/config';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { PrismaClient } from '@prisma/client';

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const parentsSheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Родители';
  const answersSheetName = process.env.GOOGLE_SHEETS_ANSWERS_SHEET_NAME ?? 'Ответы';
  const statsSheetName = process.env.GOOGLE_SHEETS_STATS_SHEET_NAME ?? 'Статистика';
  const remindersSheetName = 'Напоминания';
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL!;
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY!.replace(/\\n/g, '\n');

  const auth = new JWT({ email: clientEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  // Вкладки могли ещё не существовать (ни один тик воркера не прошёл) —
  // тогда просто нечего чистить, это не ошибка. Диапазон до Z с запасом,
  // чтобы не завязываться на текущее число колонок.
  const clear = async (range: string, done: string) => {
    try {
      await sheets.spreadsheets.values.clear({ spreadsheetId, range });
      console.log(`✓ ${done}`);
    } catch {
      console.log(`(вкладки для "${range}" ещё нет — пропускаю)`);
    }
  };
  await clear(`${parentsSheetName}!A2:Z`, `Строки в "${parentsSheetName}" очищены, шапка оставлена`);
  await clear(answersSheetName, `Вкладка "${answersSheetName}" очищена целиком`);
  await clear(remindersSheetName, `Вкладка "${remindersSheetName}" очищена целиком`);
  await clear(statsSheetName, `Вкладка "${statsSheetName}" очищена целиком`);

  const prisma = new PrismaClient();
  await prisma.syncCursor.deleteMany({ where: { key: 'answers_sheet' } });
  await prisma.$disconnect();
  console.log('✓ Курсор выгрузки ответов сброшен');
}

main();
