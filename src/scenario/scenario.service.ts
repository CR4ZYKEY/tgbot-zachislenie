import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { Scenario, ScenarioSchema, Screen } from '../../scenario/schema';

// Загружает и валидирует scenario.yaml один раз при старте процесса.
// Раздел 8.9 CLAUDE.md: битый сценарий — приложение не поднимается.
// И bot, и worker читают сценарий только через этот сервис — никогда
// напрямую файл, чтобы гарантированно работать с провалидированными данными.
@Injectable()
export class ScenarioService implements OnModuleInit {
  private scenario!: Scenario;
  private screensById = new Map<string, Screen>();

  onModuleInit(): void {
    const path = resolve(__dirname, '..', '..', 'scenario', 'scenario.yaml');
    const parsed = load(readFileSync(path, 'utf8'));
    const result = ScenarioSchema.safeParse(parsed);

    if (!result.success) {
      const details = result.error.issues.map((i) => `  - ${i.message}`).join('\n');
      throw new Error(`Сценарий не прошёл проверку (${path}):\n${details}`);
    }

    this.scenario = result.data;
    for (const screen of this.scenario.screens) {
      this.screensById.set(screen.id, screen);
    }
  }

  getScreen(id: string): Screen {
    const screen = this.screensById.get(id);
    if (!screen) throw new Error(`Неизвестный screen_id: "${id}"`);
    return screen;
  }

  hasScreen(id: string): boolean {
    return this.screensById.has(id);
  }

  get system(): Scenario['system'] {
    return this.scenario.system;
  }

  get version(): string {
    return this.scenario.version;
  }
}
