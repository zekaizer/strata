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

const CHAINED = /^(squash|s|fixup|f)\s/;

/** `line` of a rebase todo list, as a dialog names it, when git opens the commit message editor for it. */
function messageEdit(line: string): string | undefined {
  const [word = '', ...args] = line.split(/\s+/);
  const command = ({ r: 'reword', s: 'squash', f: 'fixup', m: 'merge' } as Record<string, string>)[word] ?? word;
  const short = (commit: string | undefined) => commit?.slice(0, 7) ?? '';
  switch (command) {
    case 'reword':
    case 'squash':
      return `${command} ${short(args[0])}`;
    case 'fixup':
      return args[0] === '-c' ? `fixup -c ${short(args[1])}` : undefined;
    case 'merge':
      // -C reuses that commit's message; -c opens it in the editor, and so does no option.
      return args[0] === '-C' ? undefined : `merge ${args[0] === '-c' ? args[2] : args[0]}`;
    default:
      return undefined;
  }
}

/**
 * The steps of a stopped rebase that Continue would have git open the commit message editor for:
 * the stopped step of `done` (with the squash or fixup chain it ends, whose message git edits once
 * the chain is applied) and the steps left in `todo`. An `edit` is not one: git stops there.
 */
export function messageEdits(done: string, todo: string): string[] {
  const finished = steps(done);
  let first = finished.length - 1;
  while (first > 0 && CHAINED.test(finished[first]!) && CHAINED.test(finished[first - 1]!)) first--;
  return [...finished.slice(Math.max(first, 0)), ...steps(todo)].flatMap((l) => messageEdit(l) ?? []);
}
