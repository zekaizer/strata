// Writes fixture repositories to out/fixtures/<scenario>, and fixture workspaces of several.
// Usage: node test/fixtures/cli.ts [scenario ...]   (default: all)
import '../isolate-git.ts';
import { join } from 'node:path';
import { scenarios, type ScenarioName } from './scenarios.ts';
import { workspaces } from './workspaces.ts';

const known = [...Object.keys(scenarios), ...Object.keys(workspaces)];
const names = process.argv.slice(2);
for (const name of names.length ? names : known) {
  const dir = join('out', 'fixtures', name);
  if (name in scenarios) scenarios[name as ScenarioName]().write(dir);
  else if (name in workspaces) workspaces[name as keyof typeof workspaces](dir);
  else {
    console.error(`unknown scenario ${name}; known: ${known.join(', ')}`);
    process.exit(2);
  }
  console.log(dir);
}
