import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ScenarioModule } from '../scenario/scenario.module';
import { RenderModule } from '../render/render.module';
import { EngineService } from './engine.service';
import { BotService } from './bot.service';

@Module({
  imports: [PrismaModule, ScenarioModule, RenderModule],
  providers: [EngineService, BotService],
})
export class AppModule {}
