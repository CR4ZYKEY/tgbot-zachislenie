import { Module } from '@nestjs/common';
import { ScreenRendererService } from './screen-renderer.service';

// Показ экрана сценария в чат. Импортируется обоими процессами: `bot`
// показывает экраны в ответ на действия родителя, `worker` — когда шлёт
// напоминание из очереди `jobs`. PrismaModule и ScenarioModule глобальные,
// поэтому в imports их перечислять не нужно.
@Module({
  providers: [ScreenRendererService],
  exports: [ScreenRendererService],
})
export class RenderModule {}
