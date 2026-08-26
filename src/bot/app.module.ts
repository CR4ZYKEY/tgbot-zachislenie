import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ScenarioModule } from '../scenario/scenario.module';
import { EngineService } from './engine.service';
import { BotService } from './bot.service';

@Module({
  imports: [PrismaModule, ScenarioModule],
  providers: [EngineService, BotService],
})
export class AppModule {}
