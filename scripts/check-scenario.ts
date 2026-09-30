// npm run scenario:check
// Раздел 8.9 docs/spec.md / п.3 «Порядок» — движок не должен запускаться
// на битом сценарии: несуществующий переход, дубль screen_id, кнопка без
// обработчика. Этот скрипт — та же проверка, что должна идти при старте
// приложения (см. src/bot/main.ts).

import { existsSync } from 'fs';
import { resolve } from 'path';
import { ScenarioSchema } from '../scenario/schema';
import { loadRawScenario, scenarioDir } from '../scenario/load';

function main(): void {
  const path = scenarioDir();
  const parsed = loadRawScenario(path);

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

  // Файлы по кнопкам: картинке позволено ещё не существовать (черновой путь
  // с ✎), а кнопка «Получить инструкцию» без файла молча ничего бы не делала.
  const missingDocs = screens.flatMap((s) =>
    (s.buttons ?? [])
      .filter((b) => b.document && !existsSync(resolve(__dirname, '..', 'assets', b.document)))
      .map((b) => `Экран "${s.id}": файл кнопки "${b.data}" не найден: assets/${b.document}`),
  );
  if (missingDocs.length) {
    console.error(`✗ Сценарий не прошёл проверку: ${path}\n`);
    for (const m of missingDocs) console.error(`  - ${m}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ Сценарий валиден: ${screens.length} экранов, версия ${result.data.version}`);
}

main();
