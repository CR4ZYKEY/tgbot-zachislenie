import { Injectable, Logger } from '@nestjs/common';
import type { Context } from 'grammy';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { ScreenRendererService } from '../render/screen-renderer.service';
import { Button, SYSTEM_SCREEN_KEYS, SystemScreenKey } from '../../scenario/schema';
import { renderTemplate } from '../render/template.util';
import { buildScreenKeyboard, buildSystemKeyboard, decodeCallback } from '../render/keyboard.util';
import { normalizePhone } from './phone.util';
import { sanitizeFreeText } from './sanitize.util';

function isSystemKey(t: string): t is SystemScreenKey {
  return (SYSTEM_SCREEN_KEYS as readonly string[]).includes(t);
}

// Движок диалога: обработка callback и свободного ввода, запись ответа,
// переход между экранами. Сам показ экрана — в ScreenRendererService, он же
// общий с воркером напоминаний. Ничего пользовательского текста здесь не
// хардкодится — только то, что лежит в scenario.yaml (правило 1 CLAUDE.md).
@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scenario: ScenarioService,
    // Сам показ экрана живёт в общем сервисе: тем же кодом воркер шлёт
    // напоминания, иначе тексты и версии кнопок разъехались бы.
    private readonly renderer: ScreenRendererService,
  ) {}

  async getOrCreateUser(tgId: bigint): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { tgId } });
    if (existing) return existing;
    return this.prisma.user.create({ data: { tgId, stage: 's0' } });
  }

  // Точка входа: /start. Новому родителю показываем s0, вернувшемуся —
  // перерисовываем текущий экран (состояние живёт в Postgres, п.2 CLAUDE.md).
  async start(ctx: Context, tgId: bigint): Promise<void> {
    const user = await this.getOrCreateUser(tgId);
    await this.render(ctx, user, user.stage, { pushHistory: false });
  }

  // Показ экрана в ответ на действие родителя. Вся механика (история,
  // renderVersion, картинка, постановка напоминаний) — в общем рендере,
  // здесь только достаём из grammY-контекста то, что ему нужно.
  private async render(
    ctx: Context,
    user: User,
    targetScreenId: string,
    opts: { pushHistory: boolean; extraButtons?: Button[] } = { pushHistory: true },
  ): Promise<void> {
    await this.renderer.renderScreen(ctx.api, ctx.chat!.id, user, targetScreenId, opts);
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
    const text = renderTemplate(sys.text, this.renderer.buildVars(user));
    // "stop" — единственное исключение: после него возвращаться уже некуда,
    // данные пользователя удалены. Остальные оверлеи всегда получают
    // "← Назад", если только в самом сценарии уже нет кнопки с тем же
    // смыслом (как "Да, к текущему шагу" на stale) — не дублируем.
    const alreadyHasReturn = sys.buttons?.some((b) => b.next === 'current_screen') ?? false;
    const kb = buildSystemKeyboard(sys, key, user.renderVersion, this.renderer.urlVars(user), {
      includeBack: key !== 'stop' && !alreadyHasReturn,
    });

    const chatId = ctx.chat!.id;
    if (user.lastOverlayMessageId) {
      await ctx.api.deleteMessage(chatId, user.lastOverlayMessageId).catch(() => {
        // Сообщение могли удалить руками или оно устарело для удаления — не критично.
      });
    }
    const assetPath = this.renderer.resolveAsset(sys.image, `оверлея "${key}"`);
    const sent = await this.renderer.sendTextOrPhoto(ctx.api, chatId, assetPath, text, kb);
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
    await ctx.reply(this.scenario.system.stop.text, { parse_mode: 'HTML' });
  }

  // "Статус зачисления" из меню/команды /status: если построенный путь уже
  // пройден (screen.terminal — сейчас это конец Этапа 2, до появления
  // этапов 3–6) — показываем отдельное поздравление вместо повтора того же
  // финального экрана. Если родитель ещё в процессе — просто возвращаем
  // его туда, где он остановился, как и раньше.
  async runStatusCommand(ctx: Context, tgId: bigint): Promise<void> {
    const user = await this.getOrCreateUser(tgId);
    await this.showStatus(ctx, user);
  }

  // "Показать статус" — общая точка и для команды /status, и для кнопки
  // "Статус зачисления" внутри меню. Закрывает текущий оверлей (если он
  // был), затем: путь уже пройден (screen.terminal) — показывает отдельное
  // поздравление; иначе — просто возвращает туда, где родитель остановился.
  private async showStatus(ctx: Context, user: User): Promise<void> {
    if (user.lastOverlayMessageId) {
      await ctx.api.deleteMessage(ctx.chat!.id, user.lastOverlayMessageId).catch(() => {
        // Уже удалено/недоступно — не критично.
      });
      await this.prisma.user.update({ where: { id: user.id }, data: { lastOverlayMessageId: null } }).catch(() => {});
    }
    const screen = this.scenario.getScreen(user.stage);
    if (screen.terminal) {
      await this.showOverlay(ctx, user, 'status_complete');
      return;
    }
    await this.render(ctx, user, user.stage, { pushHistory: false });
  }

  // Возврат из оверлея ("← Назад", "Да, к текущему шагу" на stale, "Статус
  // зачисления" из меню). Если оверлей был открыт прямым кликом из меню
  // (overlayBackTarget === 'menu' — см. showOverlay) — возвращаемся в меню,
  // а не в поток: иначе "Важные сроки" → "Назад" уносило бы прямиком на
  // "Шаг 2 из 6", а не туда, откуда реально пришли.
  //
  // Во всех остальных случаях: удаляем сам оверлей (он всплывающий, история
  // ему не нужна) и шлём текущий экран новым сообщением — как и весь
  // остальной поток теперь (см. render()): новое сообщение и перевыпускает
  // неустаревшие кнопки, и остаётся в истории чата.
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
      // "current_screen" ведёт не на другой оверлей, а обратно в основную
      // ленту (или в меню, если и туда пришли из меню — см. returnFromOverlay).
      // Обычный dispatch() тихо отредактировал бы старое сообщение, невидимое
      // без прокрутки, и клик выглядел бы так, будто кнопка "никуда не
      // ведёт" (ровно этот баг и был).
      if (button.next === 'current_screen') {
        await this.returnFromOverlay(ctx, user);
        return;
      }
      // "status" — отдельная логика (см. showStatus): путь мог быть уже
      // пройден, тогда нужно поздравление, а не повтор финального экрана.
      if (button.next === 'status') {
        await this.showStatus(ctx, user);
        return;
      }
      // Клик сделан прямо на сообщении меню ("☰ Меню" → пункт) — у экрана,
      // на который ведёт этот пункт, "← Назад" должна возвращать в меню,
      // а не в поток. Для остальных путей к тому же оверлею (например, КС
      // с любого экрана этапов 1–2) поведение не меняется.
      const cameFromMenu = decoded.screenId === 'menu';
      await this.dispatch(ctx, user, button.next!, cameFromMenu ? 'menu' : undefined);
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

    // Кнопка с файлом (памятка МЦКО): присылаем документ. Без next родитель
    // остаётся на экране — его кнопки в сообщении выше по-прежнему рабочие.
    if (button.document) {
      await this.renderer.sendDocument(ctx.api, ctx.chat!.id, button.document, `экрана "${screen.id}"`);
      if (!button.next) return;
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

  private async dispatch(ctx: Context, user: User, target: string, overlayBackTarget?: 'menu'): Promise<void> {
    if (target === 'current_screen') {
      await this.render(ctx, user, user.stage, { pushHistory: false });
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
    if (target === 'wait') {
      await this.acknowledgeAndWait(ctx, user);
      return;
    }
    if (isSystemKey(target)) {
      await this.showOverlay(ctx, user, target, overlayBackTarget);
      return;
    }
    await this.render(ctx, user, target, { pushHistory: true });
  }

  // «Понятно» на экране-ожидании (next: wait): родитель остаётся на месте,
  // дальше бот напишет сам по дате. С сообщения убираем кнопки ответа —
  // видно, что нажатие принято, и повторно нажимать нечего. «← Назад» и
  // «☰ Меню» остаются: из ожидания должно быть куда выйти.
  private async acknowledgeAndWait(ctx: Context, user: User): Promise<void> {
    const screen = this.scenario.getScreen(user.stage);
    const kb = buildScreenKeyboard({ ...screen, buttons: undefined }, user.renderVersion, {
      backTarget: screen.back ?? user.historyStack[user.historyStack.length - 1],
      urlVars: this.renderer.urlVars(user),
    });
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch((err) => {
      this.logger.warn(`Не удалось убрать кнопки на "${screen.id}": ${err instanceof Error ? err.message : err}`);
    });
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
            { pushHistory: false, extraButtons: [screen.input.skipButton] },
          );
        } else {
          await this.showOverlay(ctx, user, 'phone_invalid');
        }
        return;
      }

      await this.prisma.answer.create({ data: { userId: user.id, screenId: user.stage, value: normalized } });
      await this.prisma.user.update({ where: { id: user.id }, data: { phone: normalized } });
      await this.dispatch(ctx, { ...user, phone: normalized }, next);
      return;
    }

    const clean = sanitizeFreeText(rawText);
    await this.prisma.answer.create({ data: { userId: user.id, screenId: user.stage, value: clean } });

    if (field === 'name') {
      await this.prisma.user.update({ where: { id: user.id }, data: { name: clean } });
    }

    await this.dispatch(ctx, user, next);
  }
}
