// Writes the command and menu contributions of package.json from src/shared/commands.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { syncManifest } from './lib/manifest.ts';

const url = new URL('../package.json', import.meta.url);
writeFileSync(url, syncManifest(readFileSync(url, 'utf8')));
