import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SheetsSyncService } from './sheets-sync.service';

// Тик воркера — раз в минуту (раздел 8 спеки).
// TODO: разбор таблицы jobs (включая просроченные задачи при старте —
// раздел 8.9 CLAUDE.md), тихие часы 10:00–21:00 МСК, дедупликация по
// dedup_key. Пока здесь только Sheets-синхронизация (временная, только
// для тестового бота — см. sheets-sync.service.ts).
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;

  constructor(private readonly sheetsSync: SheetsSyncService) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (this.running) return; // предыдущий тик ещё не закончился — не наслаиваем
    this.running = true;
    try {
      await this.sheetsSync.syncOnce();
    } catch (err) {
      this.logger.error(`Ошибка тика воркера: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
