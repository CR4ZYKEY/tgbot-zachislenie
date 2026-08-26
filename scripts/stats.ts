// npm run stats
//
// Отчёт по «Затруднениям» (раздел 8 docs/spec.md — таблица answers это и
// есть лист «Затруднения»). Каждый ответ/нажатие уже пишется в БД самим
// движком (engine.service.ts) — этот скрипт просто агрегирует то, что уже
// собрано, а не добавляет новый сбор данных.
//
// Два среза:
//  1. Где родители стоят ПРЯМО СЕЙЧАС (текущий stage) — живой срез воронки.
//  2. Какие экраны и ответы встречаются чаще всего в истории — где обычно
//     торможение (развилки "Нет" / "Не получается" / "Не понял" и переходы
//     в КС встречаются на этих экранах непропорционально часто).
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isFrictionAnswer } from '../src/worker/friction.util';

const prisma = new PrismaClient();

async function main() {
  const totalUsers = await prisma.user.count();
  if (totalUsers === 0) {
    console.log('Пользователей в БД нет — статистики пока не по чему строить.');
    return;
  }

  console.log(`\n=== 1. Где сейчас стоят родители (${totalUsers} всего) ===\n`);
  const byStage = await prisma.user.groupBy({
    by: ['stage'],
    _count: { _all: true },
    orderBy: { _count: { stage: 'desc' } },
  });
  for (const row of byStage) {
    const pct = ((row._count._all / totalUsers) * 100).toFixed(0);
    console.log(`  ${row.stage.padEnd(20)} ${String(row._count._all).padStart(4)}  (${pct}%)`);
  }

  console.log('\n=== 2. Трафик по экранам (сколько раз вообще отвечали) ===\n');
  const byScreen = await prisma.answer.groupBy({
    by: ['screenId'],
    _count: { _all: true },
    orderBy: { _count: { screenId: 'desc' } },
    take: 20,
  });
  for (const row of byScreen) {
    console.log(`  ${row.screenId.padEnd(20)} ${String(row._count._all).padStart(4)}`);
  }

  console.log('\n=== 3. Затруднения — экраны с наибольшей долей "проблемных" ответов ===\n');
  const answers = await prisma.answer.findMany({ select: { screenId: true, value: true } });
  const perScreen = new Map<string, { total: number; friction: number }>();
  for (const a of answers) {
    const entry = perScreen.get(a.screenId) ?? { total: 0, friction: 0 };
    entry.total += 1;
    if (isFrictionAnswer(a.value)) entry.friction += 1;
    perScreen.set(a.screenId, entry);
  }
  const ranked = [...perScreen.entries()]
    .filter(([, v]) => v.friction > 0)
    .sort((a, b) => b[1].friction / b[1].total - a[1].friction / a[1].total || b[1].friction - a[1].friction);

  if (ranked.length === 0) {
    console.log('  Проблемных ответов (Нет / Не получается / переход в КС и т.п.) пока не зафиксировано.');
  } else {
    for (const [screenId, v] of ranked) {
      const pct = ((v.friction / v.total) * 100).toFixed(0);
      console.log(`  ${screenId.padEnd(20)} ${v.friction}/${v.total} проблемных (${pct}%)`);
    }
  }

  console.log('\n=== 4. Переходы в КС — сколько раз и с каких экранов ===\n');
  const kcAnswers = answers.filter((a) => a.value.includes('.kc'));
  if (kcAnswers.length === 0) {
    console.log('  Переходов в КС пока не было.');
  } else {
    const byKc = new Map<string, number>();
    for (const a of kcAnswers) byKc.set(a.screenId, (byKc.get(a.screenId) ?? 0) + 1);
    for (const [screenId, count] of [...byKc.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${screenId.padEnd(20)} ${count}`);
    }
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error('Ошибка отчёта:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
