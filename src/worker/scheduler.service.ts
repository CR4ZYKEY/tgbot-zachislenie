import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SheetsSyncService } from './sheets-sync.service';
import { RemindersService } from './reminders.service';

// Тик воркера — раз в минуту (раздел 8 спеки): очередь напоминаний плюс
// Sheets-синхронизация (временная, только для тестового бота — см.
// sheets-sync.service.ts).
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;

  constructor(
    private readonly sheetsSync: SheetsSyncService,
    private readonly reminders: RemindersService,
  ) {}

  // При старте разбираем просроченные задачи, а не ждём первого тика:
  // локальный запуск переживает сон машины (раздел 8.9 CLAUDE.md).
  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
  }

  @Interval(60_000)
  async tick(): Promise<void> {
    if (this.running) return; // предыдущий тик ещё не закончился — не наслаиваем
    this.running = true;
    try {
      // Напоминания первыми: рассылка важнее выгрузки в таблицу, и падение
      // Sheets не должно её задерживать.
      await this.reminders.processDue();
    } catch (err) {
      this.logger.error(`Ошибка разбора напоминаний: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await this.sheetsSync.syncOnce();
    } catch (err) {
      this.logger.error(`Ошибка Sheets-синхронизации: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
