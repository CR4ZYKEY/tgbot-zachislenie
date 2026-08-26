import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// Процесс "worker": напоминания, тик раз в минуту, выгрузка в Google
// Sheets. Отдельный процесс от "bot" — падение рассылки не должно
// ронять диалоги (п.2 CLAUDE.md).

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  console.log('✓ Воркер поднят. Обработчик очереди jobs ещё не реализован (см. TODO в worker.module.ts).');
  // TODO: при старте разобрать просроченные задачи из таблицы jobs, затем тик раз в минуту.
}

bootstrap();
