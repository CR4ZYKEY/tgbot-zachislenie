import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'grammy';
import type { Job, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { ScreenRendererService } from '../render/screen-renderer.service';
import { isReminderTestMode, reminderHoursToMs } from '../render/reminder-timing.util';
import { checkReminder } from './reminder-check.util';

// Тихие часы: пишем родителю только с 10:00 до 21:00 МСК (модель напоминаний,
// CLAUDE.md). Москва — UTC+3 круглый год, перевода часов нет, поэтому хватает
// сдвига без библиотеки таймзон.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const QUIET_FROM_HOUR = 10;
const QUIET_TO_HOUR = 21;

// «Не более одного касания в сутки» — считаем по реально отправленным
// напоминаниям, а не по lastTouchAt: тот обновляется, когда родитель сам
// нажимает кнопки, и активный родитель иначе переставал бы получать
// напоминания вовсе.
const MIN_HOURS_BETWEEN_TOUCHES = 20;

// Три неотвеченных касания подряд — этап уходит на паузу (CLAUDE.md).
const MAX_CONSECUTIVE_MISSES = 3;

// Разбор очереди `jobs`: что просрочено — досылаем (в том числе то, что
// накопилось, пока машина спала), что уже неактуально — снимаем.
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);
  // Только исходящие вызовы Bot API, без long polling: апдейты забирает
  // процесс `bot`, и второй getUpdates на том же токене растащил бы нажатия
  // между процессами (CLAUDE.md, «чего не делать»).
  private readonly api: Api;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
    private readonly renderer: ScreenRendererService,
  ) {
    const token = process.env.BOT_TOKEN;
    if (!token) throw new Error('BOT_TOKEN не задан (см. .env.example)');
    // Таймаут по той же причине, что и у бота (см. bot.service.ts): дефолтные
    // 500 секунд означают, что одна зависшая отправка держала бы весь тик
    // воркера почти девять минут.
    this.api = new Api(token, { timeoutSeconds: 60 });
  }

  async processDue(now = new Date()): Promise<void> {
    const due = await this.prisma.job.findMany({
      where: { status: 'pending', runAt: { lte: now } },
      orderBy: { runAt: 'asc' },
      take: 50,
    });
    if (!due.length) return;

    this.logger.log(`Просроченных напоминаний в очереди: ${due.length}`);
    for (const job of due) {
      try {
        await this.deliver(job, now);
      } catch (err) {
        // Родитель мог заблокировать бота или удалить чат — это не повод
        // ронять весь тик и не повод пытаться вечно.
        this.logger.error(`Напоминание ${job.dedupKey} не отправлено: ${err instanceof Error ? err.message : err}`);
        await this.finish(job, 'failed');
      }
    }
  }

  private async deliver(job: Job, now: Date): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: job.userId } });
    if (!user) {
      await this.finish(job, 'cancelled');
      return;
    }

    const check = checkReminder(this.scenario, user, job.jobType);
    if (!check.ok) {
      if (check.reason === 'gone') {
        this.logger.warn(`Напоминание ${job.dedupKey}: шага "${job.jobType}" больше нет в сценарии — снимаю`);
      }
      await this.finish(job, 'cancelled');
      return;
    }
    const { reminder, stage } = check;

    // Родитель уже ответил на то, о чём напоминание (например, «Уже продлили»).
    if (reminder.skipIfAnswered) {
      const answered = await this.prisma.answer.count({
        where: { userId: user.id, value: { in: reminder.skipIfAnswered } },
      });
      if (answered > 0) {
        await this.finish(job, 'cancelled');
        return;
      }
    }

    // Этап на паузе (три неотвеченных касания подряд) — молчим.
    if (user.mutedStages.includes(stage)) {
      await this.finish(job, 'cancelled');
      return;
    }
    if (user.consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
      this.logger.log(`Родитель ${user.id}: ${user.consecutiveMisses} касаний без ответа — ставлю этап "${stage}" на паузу`);
      await this.prisma.user.update({
        where: { id: user.id },
        // Счётчик обнуляется: пауза — по одному этапу. Иначе он так и стоял
        // бы на трёх, и каждое следующее напоминание любого другого этапа
        // тоже молча уходило бы на паузу, не будучи отправленным ни разу.
        data: { mutedStages: { push: stage }, consecutiveMisses: 0 },
      });
      await this.finish(job, 'cancelled');
      return;
    }

    const postpone = await this.postponeUntil(user, now);
    if (postpone) {
      await this.prisma.job.update({ where: { id: job.id }, data: { runAt: postpone } });
      return;
    }

    // «Отправлено» ставим до показа: экран напоминания может сам поставить
    // эту же задачу заново (rearm — «спрошу ещё раз через неделю»), и отметка
    // после показа затёрла бы новую. Если отправка упадёт, processDue
    // переведёт задачу в failed.
    await this.finish(job, 'sent', now);
    await this.renderer.renderScreen(this.api, Number(user.tgId), user, reminder.screen, {
      pushHistory: true,
      // Не действие родителя: счётчик неотвеченных касаний должен расти,
      // а не обнуляться.
      byUser: false,
    });
    this.logger.log(`Напоминание ${job.dedupKey} отправлено: экран "${reminder.screen}"`);
  }

  // Когда отправлять нельзя — возвращает новое время, иначе null.
  private async postponeUntil(user: User, now: Date): Promise<Date | null> {
    const lastSent = await this.prisma.job.findFirst({
      where: { userId: user.id, status: 'sent' },
      orderBy: { sentAt: 'desc' },
    });
    // Пауза между касаниями сжимается вместе со сроками: иначе в тестовом
    // режиме второе напоминание (через пару минут) упёрлось бы в 20 часов.
    const minGapMs = reminderHoursToMs(MIN_HOURS_BETWEEN_TOUCHES);
    if (lastSent?.sentAt && now.getTime() - lastSent.sentAt.getTime() < minGapMs) {
      return this.nextAllowedSlot(new Date(lastSent.sentAt.getTime() + minGapMs));
    }
    const slot = this.nextAllowedSlot(now);
    return slot.getTime() > now.getTime() ? slot : null;
  }

  // Ближайший момент внутри тихих часов: в окне — само время, до 10:00 —
  // сегодняшнее утро, после 21:00 — завтрашнее.
  private nextAllowedSlot(from: Date): Date {
    // В тестовом режиме тихие часы не действуют — иначе прогон вечером
    // молча уезжал бы на утро и выглядел бы как поломка.
    if (isReminderTestMode()) return from;

    const msk = new Date(from.getTime() + MSK_OFFSET_MS);
    const hour = msk.getUTCHours();
    if (hour >= QUIET_FROM_HOUR && hour < QUIET_TO_HOUR) return from;

    const morning = new Date(msk);
    if (hour >= QUIET_TO_HOUR) morning.setUTCDate(morning.getUTCDate() + 1);
    morning.setUTCHours(QUIET_FROM_HOUR, 0, 0, 0);
    return new Date(morning.getTime() - MSK_OFFSET_MS);
  }

  private async finish(job: Job, status: 'sent' | 'cancelled' | 'failed', sentAt?: Date): Promise<void> {
    await this.prisma.job.update({
      where: { id: job.id },
      data: { status, ...(sentAt ? { sentAt } : {}) },
    });
  }
}
