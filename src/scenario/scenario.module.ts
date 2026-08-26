import { Global, Module } from '@nestjs/common';
import { ScenarioService } from './scenario.service';

@Global()
@Module({
  providers: [ScenarioService],
  exports: [ScenarioService],
})
export class ScenarioModule {}
