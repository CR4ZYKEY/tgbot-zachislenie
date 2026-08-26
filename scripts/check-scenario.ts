// npm run scenario:check
// Раздел 8.9 docs/spec.md / п.3 «Порядок» — движок не должен запускаться
// на битом сценарии: несуществующий переход, дубль screen_id, кнопка без
// обработчика. Этот скрипт — та же проверка, что должна идти при старте
// приложения (см. src/bot/main.ts).

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { ScenarioSchema } from '../scenario/schema';

function main(): void {
  const path = resolve(__dirname, '..', 'scenario', 'scenario.yaml');
  const raw = readFileSync(path, 'utf8');
  const parsed = load(raw);

  const result = ScenarioSchema.safeParse(parsed);

  if (!result.success) {
    console.error(`✗ Сценарий не прошёл проверку: ${path}\n`);
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const { screens } = result.data;
  console.log(`✓ Сценарий валиден: ${screens.length} экранов, версия ${result.data.version}`);
}

main();
