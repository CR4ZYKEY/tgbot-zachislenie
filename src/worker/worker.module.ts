import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { ScenarioModule } from '../scenario/scenario.module';
import { RenderModule } from '../render/render.module';
import { SheetsSyncService } from './sheets-sync.service';
import { SchedulerService } from './scheduler.service';
import { RemindersService } from './reminders.service';

// Тик раз в минуту (раздел 8 спеки): разбор таблицы `jobs` с тихими часами
// 10:00–21:00 МСК и дедупликацией, включая просроченные задачи при старте
// (раздел 8.9 CLAUDE.md). Sheets-синхронизация — временная, только для
// тестового бота, см. комментарий в начале sheets-sync.service.ts.
@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, ScenarioModule, RenderModule],
  providers: [SheetsSyncService, SchedulerService, RemindersService],
})
export class WorkerModule {}
