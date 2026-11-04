/**
 * Variables that make git operate on a repository other than the working
 * directory. VS Code can inherit them (e.g. when launched from a git hook);
 * Strata always addresses the repository by cwd.
 */
const REPOSITORY_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/** Environment for git child processes: no repository overrides, never prompt. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of REPOSITORY_OVERRIDES) Reflect.deleteProperty(env, k);
  return env;
}
