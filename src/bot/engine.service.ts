import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { Button, SYSTEM_SCREEN_KEYS, SystemScreenKey } from '../../scenario/schema';
import { renderTemplate, TemplateVars } from './template.util';
import { buildScreenKeyboard, buildSystemKeyboard, decodeCallback } from './keyboard.util';
import { normalizePhone } from './phone.util';
import { sanitizeFreeText } from './sanitize.util';

const HISTORY_LIMIT = 50;

function isSystemKey(t: string): t is SystemScreenKey {
  return (SYSTEM_SCREEN_KEYS as readonly string[]).includes(t);
}

// Движок диалога: рендер экрана из YAML, обработка callback, запись ответа,
// переход. Единственное место, где сценарий встречается с Telegram API.
// Ничего пользовательского текста здесь не хардкодится — только то, что
// лежит в scenario.yaml (правило 1 CLAUDE.md).
@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
  ) {}

  private buildVars(user: User): TemplateVars {
    return {
      isReturning: user.isReturning ?? false,
      class: user.class,
      name: user.name,
    };
  }

  private urlVars(user: User): TemplateVars {
    return {
      kc_username: process.env.KC_BOT_USERNAME ?? 'help_bot',
      kc_context: `step_${user.stage}`,
    };
  }

  async getOrCreateUser(tgId: bigint): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { tgId } });
    if (existing) return existing;
    return this.prisma.user.create({ data: { tgId, stage: 's0' } });
  }

  // Точка входа: /start. Новому родителю показываем s0, вернувшемуся —
  // перерисовываем текущий экран (состояние живёт в Postgres, п.2 CLAUDE.md).
  async start(ctx: Context, tgId: bigint): Promise<void> {
    const user = await this.getOrCreateUser(tgId);
    // forceNew: /start — явный запрос родителя, а не переход внутри сценария.
    // Если вернувшийся родитель стоит на том же экране, что и до перезапуска,
    // молчаливое редактирование (текст и клавиатура не меняются) выглядит
    // так, будто бот не ответил — Telegram не подсвечивает такую правку.
    await this.render(ctx, user, user.stage, { pushHistory: false, forceNew: true });
  }

  // Редактирует предыдущее сообщение основной ленты вместо того, чтобы
  // слать новое на каждый шаг (иначе диалог разъезжается сообщениями подряд).
  // Если редактировать нечего или Telegram отказал (сообщение слишком старое,
  // удалено родителем и т.п.) — отправляет новое и запоминает его id.
  private async deliver(
    ctx: Context,
    chatId: number,
    existingMessageId: number | null,
    text: string,
    kb: InlineKeyboard,
  ): Promise<number> {
    if (existingMessageId) {
      try {
        const result = await ctx.api.editMessageText(chatId, existingMessageId, text, { reply_markup: kb });
        return typeof result === 'object' ? result.message_id : existingMessageId;
      } catch (err) {
        const description = err instanceof GrammyError ? err.description : String(err);
        if (description.includes('message is not modified')) return existingMessageId;
        this.logger.warn(`Не удалось отредактировать сообщение ${existingMessageId}, отправляю новое: ${description}`);
      }
    }
    const sent = await ctx.api.sendMessage(chatId, text, { reply_markup: kb });
    return sent.message_id;
  }

  // Переход на реальный экран сценария: двигает stage, ведёт историю для
  // "← Назад", сбрасывает счётчик попыток телефона — но только если экран
  // реально меняется, а не перерисовывается тем же (иначе кнопка «Пропустить»
  // на S2b теряет свой счётчик до того, как на неё успевают нажать).
  private async render(
    ctx: Context,
    user: User,
    targetScreenId: string,
    opts: { pushHistory: boolean; extraButtons?: Button[]; forceNew?: boolean } = { pushHistory: true },
  ): Promise<void> {
    const screen = this.scenario.getScreen(targetScreenId);
    const changingScreen = user.stage !== targetScreenId;

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
        consecutiveMisses: 0,
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

    if (screen.image) {
      const assetPath = resolve(process.cwd(), 'assets', screen.image.replace(/^✎\s*/, ''));
      if (existsSync(assetPath)) {
        await ctx.replyWithPhoto(assetPath);
      } else {
        this.logger.warn(`Скриншот для экрана "${screen.id}" не найден: ${assetPath} (черновой путь в сценарии)`);
      }
    }

    const chatId = ctx.chat!.id;
    const existingMessageId = opts.forceNew ? null : updated.lastMessageId;
    const messageId = await this.deliver(ctx, chatId, existingMessageId, text, kb);
    if (messageId !== updated.lastMessageId) {
      await this.prisma.user.update({ where: { id: updated.id }, data: { lastMessageId: messageId } });
    }
  }

  // Оверлеи (меню/КС/устаревшая кнопка/...) — всегда отдельное всплывающее
  // сообщение, не редактируют ленту и не двигают renderVersion: это взгляд
  // "поверх" текущего места в сценарии, а не переход с него. Прежний оверлей
  // (если был) удаляется перед показом нового — иначе повторные "☰ Меню"
  // просто копятся друг под другом одинаковыми сообщениями.
  // backTarget: если оверлей открыт ПРЯМЫМ кликом из меню — 'menu', и тогда
  // его "← Назад" вернёт в меню, а не в основную ленту. Во всех остальных
  // случаях (клик с любого другого экрана, включая КС из потока этапов
  // 1–2) — backTarget не передаётся, поведение как раньше (назад = в поток).
  private async showOverlay(ctx: Context, user: User, key: SystemScreenKey, backTarget?: 'menu'): Promise<void> {
    const sys = this.scenario.system[key];
    const text = renderTemplate(sys.text, this.buildVars(user));
    // "stop" — единственное исключение: после него возвращаться уже некуда,
    // данные пользователя удалены. Остальные оверлеи всегда получают
    // "← Назад", если только в самом сценарии уже нет кнопки с тем же
    // смыслом (как "Да, к текущему шагу" на stale) — не дублируем.
    const alreadyHasReturn = sys.buttons?.some((b) => b.next === 'current_screen') ?? false;
    const kb = buildSystemKeyboard(sys, key, user.renderVersion, this.urlVars(user), {
      includeBack: key !== 'stop' && !alreadyHasReturn,
    });

    const chatId = ctx.chat!.id;
    if (user.lastOverlayMessageId) {
      await ctx.api.deleteMessage(chatId, user.lastOverlayMessageId).catch(() => {
        // Сообщение могли удалить руками или оно устарело для удаления — не критично.
      });
    }
    const sent = await ctx.api.sendMessage(chatId, text, { reply_markup: kb });
    // overlayBackTarget перезаписывается на каждый показ — иначе значение от
    // предыдущего оверлея (например, "menu" от КС) протекло бы в следующий
    // (скажем, в stale), и его "← Назад" вело бы не туда.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastOverlayMessageId: sent.message_id, overlayBackTarget: backTarget ?? null },
    });
  }

  private async wipeUser(ctx: Context, user: User): Promise<void> {
    // S1a «Удалить мои данные» — п.5 CLAUDE.md: реально стираем, не просто скрываем.
    // Cascade в prisma/schema.prisma удаляет answers/checklist_items/jobs вместе с users.
    await this.prisma.user.delete({ where: { id: user.id } });
    await ctx.reply(this.scenario.system.stop.text);
  }

  async runStatusCommand(ctx: Context, tgId: bigint): Promise<void> {
    const user = await this.getOrCreateUser(tgId);
    // forceNew — та же причина, что у /start: явная команда родителя должна
    // дать видимый результат новым сообщением, а не тихой правкой того, что
    // могло уйти далеко вверх по чату.
    await this.render(ctx, user, user.stage, { pushHistory: false, forceNew: true });
  }

  // Возврат из оверлея ("← Назад", "Да, к текущему шагу" на stale, "Статус
  // зачисления" из меню). Если оверлей был открыт прямым кликом из меню
  // (overlayBackTarget === 'menu' — см. showOverlay) — возвращаемся в меню,
  // а не в поток: иначе "Важные сроки" → "Назад" уносило бы прямиком на
  // "Шаг 2 из 6", а не туда, откуда реально пришли.
  //
  // Во всех остальных случаях: оверлей — это всплывающее сообщение НАД уже
  // существующим сообщением ленты, которое никуда не делось, просто
  // оказалось на строчку выше. Поэтому "назад" — это удалить оверлей и
  // ОБНОВИТЬ (не заново прислать!) то сообщение на месте: обновление нужно,
  // чтобы перевыпустить неустаревшие кнопки (типичный случай — после stale),
  // а не слать новое, иначе каждое открытие/закрытие "☰ Меню" плодило бы
  // дубль экрана — ровно тот баг, из-за которого это исправление появилось.
  private async returnFromOverlay(ctx: Context, user: User): Promise<void> {
    if (user.overlayBackTarget === 'menu') {
      await this.showOverlay(ctx, user, 'menu');
      return;
    }
    if (user.lastOverlayMessageId) {
      await ctx.api.deleteMessage(ctx.chat!.id, user.lastOverlayMessageId).catch(() => {
        // Уже удалено/недоступно — не критично.
      });
      await this.prisma.user.update({ where: { id: user.id }, data: { lastOverlayMessageId: null } }).catch(() => {});
    }
    await this.render(ctx, user, user.stage, { pushHistory: false });
  }

  async handleCallback(ctx: Context, tgId: bigint, raw: string): Promise<void> {
    const decoded = decodeCallback(raw);
    const user = await this.getOrCreateUser(tgId);

    if (!decoded) return;

    // Кнопка оверлея (меню/КС/stale/...) кодирует свой ключ вместо screen_id —
    // она не привязана к user.stage и НАМЕРЕННО обходит проверку версии/
    // экрана ниже. Оверлеи не часть отслеживаемого состояния диалога: худшее,
    // что может случиться при повторном или "устаревшем" клике по ним — движок
    // просто покажет актуальный текущий экран или свежее меню, это всегда
    // безопасно. Если бы оверлеи тоже гонялись через проверку версии, клик по
    // "Да, к текущему шагу" на экране stale сам выглядел бы устаревшим —
    // получился бы тупик без выхода (ровно так и было до этого фикса).
    if (isSystemKey(decoded.screenId)) {
      // Универсальная "← Назад" на оверлеях — добавляется движком в
      // buildSystemKeyboard, её нет в scenario.yaml, поэтому обрабатывается
      // раньше поиска кнопки в самом sys.buttons.
      if (decoded.data === '__overlay_back') {
        await this.returnFromOverlay(ctx, user);
        return;
      }
      const sys = this.scenario.system[decoded.screenId];
      const button = sys.buttons?.find((b) => b.data === decoded.data);
      if (!button) {
        this.logger.warn(`Неизвестный callback_data "${decoded.data}" на оверлее "${decoded.screenId}"`);
        return;
      }
      // "current_screen"/"status" ведут не на другой оверлей, а обратно в
      // основную ленту (или в меню, если и туда пришли из меню — см.
      // returnFromOverlay). Обычный dispatch() тихо отредактировал бы старое
      // сообщение, невидимое без прокрутки, и клик выглядел бы так, будто
      // кнопка "никуда не ведёт" (ровно этот баг и был).
      if (button.next === 'current_screen' || button.next === 'status') {
        await this.returnFromOverlay(ctx, user);
        return;
      }
      // Клик сделан прямо на сообщении меню ("☰ Меню" → пункт) — у экрана,
      // на который ведёт этот пункт, "← Назад" должна возвращать в меню,
      // а не в поток. Для остальных путей к тому же оверлею (например, КС
      // с любого экрана этапов 1–2) поведение не меняется.
      const cameFromMenu = decoded.screenId === 'menu';
      await this.dispatch(ctx, user, button.next!, false, cameFromMenu ? 'menu' : undefined);
      return;
    }

    if (decoded.renderVersion !== user.renderVersion || decoded.screenId !== user.stage) {
      // «Старые кнопки», п.1 раздела 1 спеки: бот никогда не молчит и не откатывает состояние.
      await this.showOverlay(ctx, user, 'stale');
      return;
    }

    if (decoded.data === '__menu') {
      await this.showOverlay(ctx, user, 'menu');
      return;
    }

    const screen = this.scenario.getScreen(user.stage);

    if (decoded.data === '__back') {
      const target = screen.back ?? user.historyStack[user.historyStack.length - 1];
      if (!target) return;
      // render() персистит historyStack как есть (pushHistory: false) — здесь
      // только подрезаем стек перед вызовом, отдельного апдейта не нужно.
      const poppedHistory = screen.back ? user.historyStack : user.historyStack.slice(0, -1);
      await this.render(ctx, { ...user, historyStack: poppedHistory }, target, { pushHistory: false });
      return;
    }

    const button = this.findButton(screen, decoded.data, user);
    if (!button) {
      this.logger.warn(`Неизвестный callback_data "${decoded.data}" на экране "${screen.id}"`);
      return;
    }

    await this.prisma.answer.create({
      data: { userId: user.id, screenId: user.stage, value: decoded.data },
    });

    if (button.setField) {
      // Декларативная запись выбора в профиль (package/class/isReturning) —
      // без этого нажатие "Базовый"/класса/"Впервые" оставалось бы только
      // строкой в answers, а сами поля users так и не заполнялись.
      const { field, value } = button.setField;
      await this.prisma.user.update({
        where: { id: user.id },
        data:
          field === 'isReturning'
            ? { isReturning: value === 'true' }
            : field === 'package'
              ? { package: value }
              : { class: value },
      });
    }

    if (screen.deferButton?.data === decoded.data) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { deferredStage1: true, resumePoint: user.stage },
      });
    }

    await this.dispatch(ctx, user, button.next!);
  }

  private findButton(screen: ReturnType<ScenarioService['getScreen']>, data: string, user: User): Button | undefined {
    const fromButtons = screen.buttons?.find((b) => b.data === data);
    if (fromButtons) return fromButtons;
    if (screen.deferButton?.data === data) return screen.deferButton;
    if (screen.input?.skipButton?.data === data && user.phoneAttempts >= (screen.input.maxAttempts ?? Infinity)) {
      return screen.input.skipButton;
    }
    return undefined;
  }

  // forceNew: когда переход вызван свободным текстом (handleFreeText) —
  // родитель только что отправил своё сообщение, и оно физически легло
  // ниже прежнего сообщения бота. Редактировать то, старое, бесполезно —
  // оно всё равно останется выше только что написанного текста, и придётся
  // листать вверх. Поэтому ответ на текстовый ввод — всегда новое сообщение.
  // Переходы по нажатию кнопки (forceNew: false) — как раньше, редактируем.
  private async dispatch(
    ctx: Context,
    user: User,
    target: string,
    forceNew = false,
    overlayBackTarget?: 'menu',
  ): Promise<void> {
    if (target === 'current_screen') {
      await this.render(ctx, user, user.stage, { pushHistory: false, forceNew });
      return;
    }
    if (target === 'status') {
      await this.runStatusCommand(ctx, user.tgId);
      return;
    }
    if (target === 'stop') {
      await this.wipeUser(ctx, user);
      return;
    }
    if (isSystemKey(target)) {
      await this.showOverlay(ctx, user, target, overlayBackTarget);
      return;
    }
    await this.render(ctx, user, target, { pushHistory: true, forceNew });
  }

  // Свободный ввод: ровно три места в сценарии (п.4 CLAUDE.md) — имя,
  // телефон, отзыв о Городе. Всё остальное обрабатывается как callback.
  async handleFreeText(ctx: Context, tgId: bigint, rawText: string): Promise<void> {
    const user = await this.getOrCreateUser(tgId);
    const screen = this.scenario.getScreen(user.stage);

    if (!screen.input) {
      // Свободный текст не ожидается на этом экране — сценарий говорит кнопками.
      return;
    }

    const { field, validation, next } = screen.input;

    if (validation === 'phone') {
      const normalized = normalizePhone(rawText);
      if (!normalized) {
        const attempts = user.phoneAttempts + 1;
        const maxAttempts = screen.input.maxAttempts ?? 2;
        await this.prisma.user.update({ where: { id: user.id }, data: { phoneAttempts: attempts } });

        if (attempts >= maxAttempts && screen.input.skipButton) {
          await this.render(
            ctx,
            { ...user, phoneAttempts: attempts },
            user.stage,
            { pushHistory: false, extraButtons: [screen.input.skipButton], forceNew: true },
          );
        } else {
          await this.showOverlay(ctx, user, 'phone_invalid');
        }
        return;
      }

      await this.prisma.answer.create({ data: { userId: user.id, screenId: user.stage, value: normalized } });
      await this.prisma.user.update({ where: { id: user.id }, data: { phone: normalized } });
      await this.dispatch(ctx, { ...user, phone: normalized }, next, true);
      return;
    }

    const clean = sanitizeFreeText(rawText);
    await this.prisma.answer.create({ data: { userId: user.id, screenId: user.stage, value: clean } });

    if (field === 'name') {
      await this.prisma.user.update({ where: { id: user.id }, data: { name: clean } });
    }

    await this.dispatch(ctx, user, next, true);
  }
}
