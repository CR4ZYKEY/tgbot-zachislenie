import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Процесс "bot": диалоги, long polling. Планировщик здесь НЕ живёт —
// см. п.2 CLAUDE.md и src/worker/main.ts. Сценарий валидируется при старте
// внутри ScenarioService (раздел 8.9 docs/spec.md) — если он битый, процесс
// не поднимается.

async function bootstrap() {
  if (!process.env.BOT_TOKEN) {
    console.error('✗ BOT_TOKEN не задан (см. .env.example)');
    process.exit(1);
  }

  try {
    await NestFactory.createApplicationContext(AppModule);
  } catch (err) {
    console.error('✗ Бот не запустился:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

bootstrap();
