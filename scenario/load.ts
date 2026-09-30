// Загрузка сценария из нескольких файлов: scenario/scenario.yaml — общее
// (системные экраны, старт, «Базовый» 1–8 и 10), scenario/tariffs/*.yaml —
// по файлу на ветку тарифа. Новый тариф — новый файл, без правки кода
// (требование заказчика, CLAUDE.md, правило 1).
//
// Файл тарифа содержит только `screens:`. Всё склеивается в один сценарий
// до проверки схемой — ссылки между файлами (s3 → ветка тарифа) проверяются
// так же строго, как внутри одного файла.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { load } from 'js-yaml';

// Как и assets/, ищется от корня проекта: так путь одинаков и под ts-node,
// и в собранном dist/.
export function scenarioDir(): string {
  return resolve(process.cwd(), 'scenario');
}

export function loadRawScenario(dir = scenarioDir()): unknown {
  const main = load(readFileSync(join(dir, 'scenario.yaml'), 'utf8')) as Record<string, unknown>;
  const tariffsDir = join(dir, 'tariffs');
  if (!existsSync(tariffsDir)) return main;

  const screens = [...((main.screens as unknown[]) ?? [])];
  for (const file of readdirSync(tariffsDir).filter((f) => f.endsWith('.yaml')).sort()) {
    const part = load(readFileSync(join(tariffsDir, file), 'utf8')) as { screens?: unknown[] } | null;
    screens.push(...(part?.screens ?? []));
  }
  return { ...main, screens };
}
