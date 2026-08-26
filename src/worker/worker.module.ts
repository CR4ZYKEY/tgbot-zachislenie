import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { ScenarioModule } from '../scenario/scenario.module';
import { SheetsSyncService } from './sheets-sync.service';
import { SchedulerService } from './scheduler.service';

// Тик раз в минуту (раздел 8 спеки). Разбор таблицы `jobs` (включая
// просроченные задачи при старте — раздел 8.9 CLAUDE.md) и тихие часы
// 10:00–21:00 МСК — ещё не реализованы (см. TODO в scheduler.service.ts).
// Sheets-синхронизация — временная, только для тестового бота, см. комментарий
// в начале sheets-sync.service.ts.
@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, ScenarioModule],
  providers: [SheetsSyncService, SchedulerService],
})
export class WorkerModule {}
