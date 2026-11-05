import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RepoBuilder } from './builder.ts';

function repo(name: string, commits: number): RepoBuilder {
  const b = new RepoBuilder();
  for (let i = 1; i <= commits; i++)
    b.commit('main', `${name} commit ${i}`, {
      files: { [`${name.toLowerCase()}.txt`]: `${i}\n`, ...(name === 'Beta' ? { '.gitignore': 'vendor/\n' } : {}) },
    });
  return b;
}

/**
 * A workspace folder that is not a repository, holding the sibling repositories alpha and beta
 * and gamma nested in beta (beta ignores it). Outer repositories are written first: writing one
 * clears its folder.
 */
export function multiRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '.vscode'), { recursive: true });
  // Deep enough for VS Code to find the nested repository without an editor open in it.
  writeFileSync(join(dir, '.vscode', 'settings.json'), `${JSON.stringify({ 'git.repositoryScanMaxDepth': 3 })}\n`);
  repo('Alpha', 5).write(join(dir, 'alpha'));
  repo('Beta', 4).write(join(dir, 'beta'));
  repo('Gamma', 3).write(join(dir, 'beta', 'vendor', 'gamma'));
}

export const workspaces = { 'multi-repo': multiRepo } as const;
