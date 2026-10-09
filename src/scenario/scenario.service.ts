import { Injectable, OnModuleInit } from '@nestjs/common';
import { Scenario, ScenarioSchema, Screen } from '../../scenario/schema';
import { loadRawScenario, scenarioDir } from '../../scenario/load';

// Загружает и валидирует сценарий (scenario.yaml + scenario/tariffs/*.yaml) один раз при старте процесса.
// Раздел 8.9 CLAUDE.md: битый сценарий — приложение не поднимается.
// И bot, и worker читают сценарий только через этот сервис — никогда
// напрямую файл, чтобы гарантированно работать с провалидированными данными.
@Injectable()
export class ScenarioService implements OnModuleInit {
  private scenario!: Scenario;
  private screensById = new Map<string, Screen>();

  onModuleInit(): void {
    const path = scenarioDir();
    const parsed = loadRawScenario(path);
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

  get packageFlags(): Record<string, string[]> {
    return this.scenario.packageFlags ?? {};
  }

  get packageVars(): Record<string, Record<string, string>> {
    return this.scenario.packageVars ?? {};
  }

  get ui(): { answeredPrefix: string; heroLabel: string; heroAdd: string; heroPrefix: string } {
    const ui = this.scenario.ui;
    return {
      answeredPrefix: ui?.answeredPrefix ?? '',
      heroLabel: ui?.heroLabel ?? '',
      heroAdd: ui?.heroAdd ?? '',
      heroPrefix: ui?.heroPrefix ?? '',
    };
  }

  get version(): string {
    return this.scenario.version;
  }
}
