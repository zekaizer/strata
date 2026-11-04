// Writes fixture repositories to out/fixtures/<scenario>.
// Usage: node test/fixtures/cli.ts [scenario ...]   (default: all)
import { join } from 'node:path';
import { scenarios, type ScenarioName } from './scenarios.ts';

const names = process.argv.slice(2);
for (const name of names.length ? names : Object.keys(scenarios)) {
  if (!(name in scenarios)) {
    console.error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(', ')}`);
    process.exit(2);
  }
  const dir = join('out', 'fixtures', name);
  scenarios[name as ScenarioName]().write(dir);
  console.log(dir);
}
