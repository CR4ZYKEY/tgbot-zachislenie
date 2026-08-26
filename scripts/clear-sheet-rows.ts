// Разовый админ-скрипт (часть «газ с начала»): очищает строки данных
// и в основной вкладке (Лист1), и в логе ответов (Ответы), оставляя
// заголовки. Плюс сбрасывает курсор выгрузки ответов в БД — иначе
// воркер решит, что уже всё выгрузил (курсор по времени последнего
// ответа), хотя вкладка теперь пустая, и не покажет свежие ответы,
// пока их createdAt не перегонит старый курсор.
//
// Использовать после ручного удаления пользователей из БД в обход
// синхронизации (напрямую через psql) — иначе в таблицах остаются
// «осиротевшие» записи, которые воркер сам не подчистит.
import 'dotenv/config';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { PrismaClient } from '@prisma/client';

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Users';
  const answersSheetName = process.env.GOOGLE_SHEETS_ANSWERS_SHEET_NAME ?? 'Ответы';
  const statsSheetName = process.env.GOOGLE_SHEETS_STATS_SHEET_NAME ?? 'Статистика';
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL!;
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY!.replace(/\\n/g, '\n');

  const auth = new JWT({ email: clientEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A2:Z` });
  console.log(`✓ Строки данных в "${sheetName}" очищены, заголовок оставлен`);

  // Вкладки "Ответы"/"Статистика" могли ещё не существовать (если ни один
  // тик воркера ещё не прошёл) — тогда просто нечего чистить, это не ошибка.
  // Диапазон "A2:Z" с запасом — не завязываемся на текущее число колонок,
  // иначе при следующем добавлении столбца (как уже было с "Проблема?")
  // старые значения в "лишних" колонках снова останутся неочищенными.
  try {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${answersSheetName}!A2:Z` });
    console.log(`✓ Строки данных в "${answersSheetName}" очищены, заголовок оставлен`);
  } catch (err) {
    console.log(`(вкладка "${answersSheetName}" ещё не создана — пропускаю)`);
  }

  // "Статистика" — целиком производный отчёт (пересчитывается каждый тик),
  // без заголовка-константы. Чистим целиком — свежие цифры появятся сами
  // на следующем тике воркера, ждать 60 секунд для этого не нужно.
  try {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: statsSheetName });
    console.log(`✓ Вкладка "${statsSheetName}" полностью очищена`);
  } catch (err) {
    console.log(`(вкладка "${statsSheetName}" ещё не создана — пропускаю)`);
  }

  const prisma = new PrismaClient();
  await prisma.syncCursor.deleteMany({ where: { key: 'answers_sheet' } });
  await prisma.$disconnect();
  console.log('✓ Курсор выгрузки ответов сброшен');
}

main();
