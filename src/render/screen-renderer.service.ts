import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { basename, relative, resolve } from 'path';
import { GrammyError, InputFile } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { Button, Reminder, Screen } from '../../scenario/schema';
import { renderTemplate, TemplateVars } from './template.util';
import { buildScreenKeyboard, encodeCallback } from './keyboard.util';
import { reminderDateToRunAt, reminderHoursToMs } from './reminder-timing.util';

const HISTORY_LIMIT = 50;
// CLAUDE.md: «абсолютный триггер ближе 14 дней от старта не создаётся».
const DEFAULT_MIN_DAYS_FROM_START = 14;

export interface RenderOptions {
  pushHistory: boolean;
  extraButtons?: Button[];
  // false — экран показан по инициативе бота (напоминание из воркера), а не
  // в ответ на действие родителя. Влияет только на счётчик неотвеченных
  // касаний: ответное сообщение его обнуляет, напоминание — увеличивает.
  byUser?: boolean;
  // Подпись кнопки, которую родитель только что нажал: на прошлом сообщении
  // вместо его кнопок останется одна неактивная «✓ <ответ>» — видно, что выбрано.
  answeredLabel?: string;
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
  // картинка шлётся им, без повторной заливки байтов. Первый уровень кэша —
  // память процесса, второй — таблица photo_cache: она переживает рестарты
  // и общая для bot и worker. Ключ — путь относительно assets/, общий для
  // всех пользователей, т.к. сама картинка от них не зависит.
  private readonly photoFileIds = new Map<string, { fingerprint: string; fileId: string }>();
  // sha1 содержимого, пересчитывается только когда у файла изменились размер
  // или время изменения — иначе каждая отправка читала бы файл с диска.
  private readonly fingerprints = new Map<string, { size: number; mtimeMs: number; hash: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
  ) {}

  buildVars(user: User): TemplateVars {
    const vars: TemplateVars = {
      // Номер героя (ребёнка) у родителя — по нему кнопки знают, чей это путь.
      slot: user.slot,
      package: user.package,
      isReturning: user.isReturning ?? false,
      class: user.class,
      name: user.name,
      // Путь выпускника: тексты ОГЭ/ЕГЭ различаются по классу — шаблон умеет
      // только {{#if флаг}}, поэтому класс 11 отдаётся отдельным флагом.
      grade11: user.class === '11',
      // Флаги тарифа (isGraduate, hasCurator, …) — из packageFlags сценария.
      ...Object.fromEntries(
        Object.entries(this.scenario.packageFlags).map(([flag, packages]) => [flag, packages.includes(user.package ?? '')]),
      ),
      // Значения тарифа (curatorUrl, curatorLabel, …) — из packageVars сценария.
      ...Object.fromEntries(
        Object.entries(this.scenario.packageVars).map(([name, byPackage]) => [name, byPackage[user.package ?? ''] ?? '']),
      ),
    };
    // Заголовок шага, на котором родитель сейчас («Шаг 5 из 8 · Подготовка»),
    // без разметки — для карточки «Статус зачисления». На старте пусто.
    const current = this.scenario.hasScreen(user.stage) ? this.scenario.getScreen(user.stage).stepLabel : undefined;
    vars.currentStep = current ? renderTemplate(current, vars).replace(/<[^>]+>/g, '') : '';
    return vars;
  }

  // Переменные для кнопок: и ссылки КС, и подписи вроде «Решу ОГЭ / Решу ЕГЭ».
  urlVars(user: User): TemplateVars {
    return {
      ...this.buildVars(user),
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
        // Пауза — не навсегда: родитель снова ответил, и напоминания по
        // поставленным на паузу этапам возвращаются.
        ...(byUser ? { mutedStages: [] } : {}),
      },
    });

    // Несколько детей у родителя — над каждым шагом «Герой N · пакет, класс»,
    // иначе непонятно, о ком сообщение (особенно в напоминаниях).
    const heroes = await this.prisma.user.count({ where: { tgId: updated.tgId } });
    const heroLine = heroes > 1 && this.scenario.ui.heroPrefix ? `${this.scenario.ui.heroPrefix}\n` : '';
    // Заголовок шага — отдельной строкой, после него пустая строка.
    const head = heroLine + (screen.stepLabel ? `${screen.stepLabel}\n` : '');
    const prefix = head ? `${head}\n` : '';
    // Заголовок шага — тоже шаблон: «Итоговое собеседование / сочинение» по классу.
    const text = renderTemplate(prefix + screen.text, this.buildVars(updated));

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
      await this.stripKeyboard(api, chatId, updated.lastMessageId, opts.answeredLabel, updated);
    }

    await this.scheduleReminders(updated, screen);
    return updated;
  }

  // Кнопки живут только на актуальном экране: у прошлого сообщения их
  // снимаем, текст и картинка остаются в истории чата. Снимаем уже после
  // отправки нового — если отправка не удалась, старые кнопки ещё рабочие.
  // Сбой тут не критичен (сообщение удалили руками и т.п.): на случай
  // уцелевших кнопок есть проверка renderVersion в движке («Старые кнопки»).
  private async stripKeyboard(api: Api, chatId: number, messageId: number | null, answeredLabel?: string, user?: User): Promise<void> {
    if (!messageId) return;
    // Ответ родителя оставляем на сообщении неактивной кнопкой — иначе в
    // истории видны только вопросы бота, а что выбрано, не видно.
    const answered = answeredLabel && user
      ? new InlineKeyboard().text(
          this.scenario.ui.answeredPrefix + renderTemplate(answeredLabel, this.buildVars(user)),
          encodeCallback('done', '__done', 0),
        )
      : undefined;
    await api.editMessageReplyMarkup(chatId, messageId, answered ? { reply_markup: answered } : undefined).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/message is not modified/i.test(msg)) this.logger.warn(`Не удалось снять кнопки с сообщения ${messageId}: ${msg}`);
    });
  }

  // Родитель ответил, но экран не сменился: «Понятно» на экране ожидания
  // (next: wait) или кнопка с файлом. Для модели напоминаний это такой же
  // ответ, как переход, — иначе после трёх «Ещё не знаем» подряд этап ушёл
  // бы на паузу, хотя родитель отвечал каждый раз.
  async markResponded(user: User): Promise<void> {
    if (user.consecutiveMisses === 0 && user.mutedStages.length === 0) return;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { consecutiveMisses: 0, mutedStages: [] },
    });
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
      // Напоминание для другого класса (у 9 и 11 разные даты допуска).
      if (reminder.forClass && !reminder.forClass.includes(user.class ?? '')) continue;

      const runAt = this.reminderRunAt(reminder, user, now);
      if (!runAt) continue;

      const dedupKey = `${user.id}:${screen.id}:${index}`;
      try {
        // rearm: «спрошу ещё раз через неделю» — прошлое напоминание уже ушло
        // (или как раз сейчас уходит: воркер рисует этот же экран), ставим
        // следующее. Ждущее своего часа не трогаем — срок не сдвигается.
        if (reminder.rearm) {
          const existing = await this.prisma.job.findUnique({ where: { dedupKey } });
          if (existing && (existing.status !== 'pending' || existing.runAt.getTime() <= now)) {
            await this.prisma.job.update({
              where: { dedupKey },
              data: { status: 'pending', runAt, sentAt: null },
            });
            continue;
          }
        }
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

  // Когда отправить напоминание, или null — если ставить его не нужно.
  // Правила абсолютных триггеров из CLAUDE.md: прошедшие даты не создаются,
  // дата ближе minDaysFromStart (по умолчанию 14) к старту родителя в боте —
  // тоже, чтобы новичка не засыпало напоминаниями в первые же дни.
  private reminderRunAt(reminder: Reminder, user: User, now: number): Date | null {
    if (reminder.afterHours != null) {
      return new Date(now + reminderHoursToMs(reminder.afterHours));
    }
    const runAt = reminderDateToRunAt(reminder.at!);
    if (runAt.getTime() <= now) return null;
    const minDays = reminder.minDaysFromStart ?? DEFAULT_MIN_DAYS_FROM_START;
    const daysFromStart = (runAt.getTime() - user.createdAt.getTime()) / 86_400_000;
    if (daysFromStart < minDays) return null;
    return runAt;
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
    const opts = { caption: text, reply_markup: kb, parse_mode: 'HTML' as const };
    const key = relative(resolve(process.cwd(), 'assets'), assetPath).replace(/\\/g, '/');
    const fingerprint = await this.fingerprint(assetPath);

    // Картинку уже заливали (этим или другим процессом, до рестарта или после)
    // — шлём по file_id, без повторной загрузки байтов.
    const cachedFileId = await this.lookupFileId(key, fingerprint);
    if (cachedFileId) {
      try {
        return await api.sendPhoto(chatId, cachedFileId, opts);
      } catch (err) {
        // file_id больше не годится: сменили токен бота или Telegram забыл
        // файл. Молча перезальём ниже. Остальные ошибки — не наша забота здесь.
        if (!(err instanceof GrammyError && err.error_code === 400)) throw err;
        this.logger.warn(`file_id для ${key} не принят Telegram (${err.description}) — перезаливаю файл`);
      }
    }

    const sent = await api.sendPhoto(chatId, new InputFile(assetPath), opts);
    const fileId = sent.photo.at(-1)?.file_id;
    if (fileId) await this.rememberFileId(key, fingerprint, fileId);
    return sent;
  }

  // Файл по кнопке (памятка МЦКО). Тот же кэш file_id, что у картинок:
  // ключ — путь от assets/, так что PDF заливается в Telegram один раз.
  // Имя файла у родителя — имя файла на диске (см. document в schema.ts).
  async sendDocument(api: Api, chatId: number, document: string, contextLabel: string): Promise<void> {
    const assetPath = this.resolveAsset(document, contextLabel);
    if (!assetPath) return;
    const key = relative(resolve(process.cwd(), 'assets'), assetPath).replace(/\\/g, '/');
    const fingerprint = await this.fingerprint(assetPath);

    const cachedFileId = await this.lookupFileId(key, fingerprint);
    if (cachedFileId) {
      try {
        await api.sendDocument(chatId, cachedFileId);
        return;
      } catch (err) {
        if (!(err instanceof GrammyError && err.error_code === 400)) throw err;
        this.logger.warn(`file_id для ${key} не принят Telegram (${err.description}) — перезаливаю файл`);
      }
    }

    const sent = await api.sendDocument(chatId, new InputFile(assetPath, basename(assetPath)));
    const fileId = sent.document?.file_id;
    if (fileId) await this.rememberFileId(key, fingerprint, fileId);
  }

  private async fingerprint(assetPath: string): Promise<string> {
    const st = await stat(assetPath);
    const memo = this.fingerprints.get(assetPath);
    if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return memo.hash;
    const hash = createHash('sha1').update(await readFile(assetPath)).digest('hex');
    this.fingerprints.set(assetPath, { size: st.size, mtimeMs: st.mtimeMs, hash });
    return hash;
  }

  // Сначала память процесса, потом БД. Запись с другим отпечатком — это
  // старая версия картинки под тем же именем, её file_id не годится.
  private async lookupFileId(key: string, fingerprint: string): Promise<string | null> {
    const mem = this.photoFileIds.get(key);
    if (mem?.fingerprint === fingerprint) return mem.fileId;
    try {
      const row = await this.prisma.photoCache.findUnique({ where: { path: key } });
      if (row?.fingerprint === fingerprint) {
        this.photoFileIds.set(key, { fingerprint, fileId: row.fileId });
        return row.fileId;
      }
    } catch (err) {
      // Кэш — ускорение, а не условие отправки: без него просто зальём файл.
      this.logger.warn(`Кэш картинок недоступен: ${err instanceof Error ? err.message : err}`);
    }
    return null;
  }

  private async rememberFileId(key: string, fingerprint: string, fileId: string): Promise<void> {
    this.photoFileIds.set(key, { fingerprint, fileId });
    try {
      await this.prisma.photoCache.upsert({
        where: { path: key },
        create: { path: key, fingerprint, fileId },
        update: { fingerprint, fileId },
      });
    } catch (err) {
      this.logger.warn(`Не удалось сохранить file_id для ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
