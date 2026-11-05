import type { OperationKind } from './repo-state.ts';

/** The lines of a todo list git keeps, without blank lines and `#` comments. */
const steps = (todo: string): string[] =>
  todo
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

/**
 * The cherry pick or revert of several commits whose todo list (`sequencer/todo`) is `todo`, when
 * no CHERRY_PICK_HEAD or REVERT_HEAD is left: git's Continue drops the first line, the commit it
 * stopped at, as done.
 */
export function sequencerTodo(
  todo: string,
): { kind: Extract<OperationKind, 'cherryPick' | 'revert'>; remaining: number } | undefined {
  const lines = steps(todo);
  const command = lines[0]?.split(/\s/)[0];
  const kind = command === 'pick' || command === 'p' ? 'cherryPick' : command === 'revert' ? 'revert' : undefined;
  return kind && { kind, remaining: lines.length - 1 };
}
