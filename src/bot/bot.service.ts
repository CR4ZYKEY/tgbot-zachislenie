import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Bot } from 'grammy';
import { EngineService } from './engine.service';

// Единственный провайдер grammY процесса "bot" — long polling. Планировщик
// живёт отдельно в src/worker (п.2 CLAUDE.md): падение рассылки не должно
// ронять диалоги, и наоборот — сбой polling не должен трогать очередь.
@Injectable()
export class BotService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BotService.name);
  private bot!: Bot;

  constructor(private readonly engine: EngineService) {}

  onModuleInit(): void {
    const token = process.env.BOT_TOKEN;
    if (!token) throw new Error('BOT_TOKEN не задан (см. .env.example)');

    this.bot = new Bot(token);

    this.bot.command('start', async (ctx) => {
      await this.engine.start(ctx, BigInt(ctx.from!.id));
    });

    this.bot.command('status', async (ctx) => {
      await this.engine.runStatusCommand(ctx, BigInt(ctx.from!.id));
    });

    // /dates, /help, /subjects — раздел 5 спеки. Пока без выделенных экранов
    // (этапы 3–6 не реализованы), ведём через тот же оверлей, что и "☰ Меню".
    this.bot.command(['dates', 'help', 'subjects'], async (ctx) => {
      await this.engine.runStatusCommand(ctx, BigInt(ctx.from!.id));
    });

    this.bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.engine.handleCallback(ctx, BigInt(ctx.from.id), ctx.callbackQuery.data);
    });

    this.bot.on('message:text', async (ctx) => {
      await this.engine.handleFreeText(ctx, BigInt(ctx.from!.id), ctx.message.text);
    });

    this.bot.catch((err) => {
      this.logger.error(`Ошибка обработки апдейта: ${err.message}`, err.stack);
    });

    // start() не резолвится, пока бот не остановлен — не await'им его тут,
    // иначе onModuleInit никогда не завершится.
    this.bot.start().catch((err) => this.logger.error(`Long polling упал: ${err}`));
    this.logger.log('Бот запущен (long polling).');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.bot?.stop();
  }
}
