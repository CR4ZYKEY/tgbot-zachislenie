import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// Процесс "worker": напоминания, тик раз в минуту, выгрузка в Google
// Sheets. Отдельный процесс от "bot" — падение рассылки не должно
// ронять диалоги (п.2 CLAUDE.md).

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  const testMinutes = process.env.REMINDER_TEST_MINUTES;
  console.log(
    testMinutes
      ? `✓ Воркер поднят. ВНИМАНИЕ: тестовый режим напоминаний — сутки сжаты до ${testMinutes} мин (REMINDER_TEST_MINUTES).`
      : '✓ Воркер поднят. Очередь напоминаний разбирается раз в минуту.',
  );
}

bootstrap();
