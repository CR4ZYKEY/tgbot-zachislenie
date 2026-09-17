import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { InputFile } from 'grammy';
import type { Api, InlineKeyboard } from 'grammy';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { Button, Screen } from '../../scenario/schema';
import { renderTemplate, TemplateVars } from './template.util';
import { buildScreenKeyboard } from './keyboard.util';
import { reminderHoursToMs } from './reminder-timing.util';

const HISTORY_LIMIT = 50;

export interface RenderOptions {
  pushHistory: boolean;
  extraButtons?: Button[];
  // false — экран показан по инициативе бота (напоминание из воркера), а не
  // в ответ на действие родителя. Влияет только на счётчик неотвеченных
  // касаний: ответное сообщение его обнуляет, напоминание — увеличивает.
  byUser?: boolean;
}

// Показ экрана сценария в конкретный чат. Вынесено из движка, потому что
// этим занимаются оба процесса: `bot` — в ответ на действие родителя,
// `worker` — когда шлёт напоминание. Дублировать рендер нельзя: тексты,
// клавиатуры и версия рендера обязаны совпадать, иначе кнопки из напоминания
// будут выглядеть устаревшими (проверка renderVersion в движке).
@Injectable()
export class ScreenRendererService {
  private readonly logger = new Logger(ScreenRendererService.name);

  // Telegram отдаёт file_id после первой успешной загрузки — дальше та же
  // картинка шлётся им, без повторной заливки байтов. Кэш живёт в памяти
  // процесса, ключ — путь картинки на диске, общий для всех пользователей,
  // т.к. сама картинка от них не зависит.
  private readonly photoFileIds = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
  ) {}

  buildVars(user: User): TemplateVars {
    return {
      isReturning: user.isReturning ?? false,
      class: user.class,
      name: user.name,
    };
  }

  urlVars(user: User): TemplateVars {
    return {
      kc_username: process.env.KC_BOT_USERNAME ?? 'help_bot',
      kc_context: `step_${user.stage}`,
    };
  }

  // Переход на реальный экран сценария: двигает stage, ведёт историю для
  // "← Назад", сбрасывает счётчик попыток телефона — но только если экран
  // реально меняется, а не перерисовывается тем же (иначе кнопка «Пропустить»
  // на S2b теряет свой счётчик до того, как на неё успевают нажать).
  //
  // Каждый переход — НОВОЕ сообщение (по просьбе заказчика: история должна
  // сохраняться целиком, а не стираться правкой в одном и том же сообщении).
  async renderScreen(
    api: Api,
    chatId: number,
    user: User,
    targetScreenId: string,
    opts: RenderOptions = { pushHistory: true },
  ): Promise<User> {
    const screen = this.scenario.getScreen(targetScreenId);
    const changingScreen = user.stage !== targetScreenId;
    const byUser = opts.byUser ?? true;

    const history = opts.pushHistory && changingScreen
      ? [...user.historyStack, user.stage].slice(-HISTORY_LIMIT)
      : user.historyStack;

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        stage: targetScreenId,
        renderVersion: { increment: 1 },
        historyStack: history,
        ...(changingScreen ? { phoneAttempts: 0 } : {}),
        lastTouchAt: new Date(),
        // Родитель ответил — цепочка молчания прервана. Напоминание, наоборот,
        // добавляет неотвеченное касание: три подряд ставят этап на паузу
        // (модель напоминаний, CLAUDE.md).
        consecutiveMisses: byUser ? 0 : { increment: 1 },
      },
    });

    const prefix = screen.stepLabel ? `${screen.stepLabel}\n` : '';
    const text = prefix + renderTemplate(screen.text, this.buildVars(updated));

    const showBack = Boolean(screen.back) || updated.historyStack.length > 0;
    const kb = buildScreenKeyboard(screen, updated.renderVersion, {
      backTarget: showBack ? screen.back ?? updated.historyStack[updated.historyStack.length - 1] : undefined,
      urlVars: this.urlVars(updated),
      extraButtons: [...(screen.deferButton ? [screen.deferButton] : []), ...(opts.extraButtons ?? [])],
    });

    const assetPath = this.resolveAsset(screen.image, `экрана "${screen.id}"`);
    const sent = await this.sendTextOrPhoto(api, chatId, assetPath, text, kb);
    if (sent.message_id !== updated.lastMessageId) {
      await this.prisma.user.update({ where: { id: updated.id }, data: { lastMessageId: sent.message_id } });
    }

    await this.scheduleReminders(updated, screen);
    return updated;
  }

  // Экран-«ожидание» (например, e2_2_sent: документы отправлены, ждём письма
  // от школы) ставит напоминания в очередь `jobs` — дальше их разбирает
  // воркер. dedupKey держит ровно одну задачу на пару «родитель + шаг
  // расписания»: повторный заход на тот же экран не плодит дубли и не
  // сдвигает уже назначенное время.
  private async scheduleReminders(user: User, screen: Screen): Promise<void> {
    if (!screen.reminders) return;
    const now = Date.now();

    for (const [index, reminder] of screen.reminders.schedule.entries()) {
      const dedupKey = `${user.id}:${screen.id}:${index}`;
      const runAt = new Date(now + reminderHoursToMs(reminder.afterHours));
      try {
        await this.prisma.job.upsert({
          where: { dedupKey },
          create: {
            userId: user.id,
            jobType: `${screen.id}:${index}`,
            runAt,
            dedupKey,
            status: 'pending',
          },
          // Пусто намеренно: задача уже стоит (или уже отправлена/снята) —
          // второй заход на экран не должен переносить срок и тем более
          // воскрешать отправленное напоминание.
          update: {},
        });
      } catch (err) {
        this.logger.error(
          `Не удалось поставить напоминание ${dedupKey}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // Путь к скриншоту/иллюстрации экрана или оверлея → абсолютный путь на
  // диске, либо undefined, если картинки нет или файл ещё не завезли
  // (черновой путь с ведущим ✎, см. комментарий вверху scenario.yaml).
  resolveAsset(image: string | undefined, contextLabel: string): string | undefined {
    if (!image) return undefined;
    const candidate = resolve(process.cwd(), 'assets', image.replace(/^✎\s*/, ''));
    if (existsSync(candidate)) return candidate;
    this.logger.warn(`Картинка для ${contextLabel} не найдена: ${candidate} (черновой путь в сценарии)`);
    return undefined;
  }

  // Общая точка отправки для обычных экранов и оверлеев: с картинкой — одно
  // сообщение "фото с подписью" (правило "одно сообщение — один вопрос",
  // CLAUDE.md, caption ограничен Telegram 1024 символами — при 2–4 строках
  // текста экрана не проблема); без картинки — обычный текст.
  // parse_mode HTML — сценарий выделяет важное <b>жирным</b> прямо в тексте
  // (см. scenario.yaml); HTML вместо MarkdownV2, чтобы не экранировать
  // пунктуацию («», →, тире), которой в текстах много.
  async sendTextOrPhoto(
    api: Api,
    chatId: number,
    assetPath: string | undefined,
    text: string,
    kb: InlineKeyboard,
  ): Promise<{ message_id: number }> {
    if (!assetPath) {
      return api.sendMessage(chatId, text, { reply_markup: kb, parse_mode: 'HTML' });
    }
    // Уже заливали эту картинку с этого процесса — шлём по file_id, без
    // повторной загрузки байтов (иначе каждый показ экрана переливал бы
    // мегабайты заново, отсюда и заметная задержка).
    const cached = this.photoFileIds.get(assetPath);
    const photo = cached ?? new InputFile(assetPath);
    const sent = await api.sendPhoto(chatId, photo, { caption: text, reply_markup: kb, parse_mode: 'HTML' });
    const newFileId = sent.photo.at(-1)?.file_id;
    if (newFileId && newFileId !== cached) this.photoFileIds.set(assetPath, newFileId);
    return sent;
  }
}
