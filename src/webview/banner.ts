import type { Leftover, OperationKind, OperationState } from '../core/repo-state.ts';
import { fileList, plural, rebaseContinues } from '../core/wording.ts';
import type { CommandId } from '../shared/commands.ts';

/** Which of the banner's sentences shows (design §7.2); "Resolved" and "Stopped" have no conflicts left. */
export type BannerState =
  | 'rebase'
  | 'rebaseResolved'
  | 'rebaseStopped'
  | 'merge'
  | 'mergeResolved'
  | 'mergeStopped'
  | 'sequencer'
  | 'sequencerResolved'
  | 'sequencerStopped'
  | 'sequencerEmpty'
  | 'sequencerBetween'
  | 'leftover'
  | 'leftoverResolved'
  | 'pending'
  | 'conflicts';

/** Text, or a commit's short hash that selects its row. */
export type BannerPart = string | { short: string; hash: string };

export interface BannerAction {
  label: string;
  command: CommandId;
  /** The command's menu context. */
  context?: Record<string, string>;
}

export interface Banner {
  state: BannerState;
  /** Something needs the user (warning look and icon), rather than a next step. */
  warning: boolean;
  /** Names the region for screen readers, e.g. "Rebase in progress". */
  label: string;
  parts: BannerPart[];
  actions: BannerAction[];
}

/** What the graph knows beyond the operation state. */
export interface BannerFacts {
  /** The subject of a loaded commit. */
  subject(hash: string): string | undefined;
  /** A branch (else remote-tracking branch, else tag) at the commit. */
  name(hash: string): string | undefined;
  /** Whether this stop had conflicts when it was seen before: none now means they were resolved. */
  hadConflicts: boolean;
}

export const OPERATION_LABEL: Record<OperationKind, string> = {
  rebase: 'Rebase',
  merge: 'Merge',
  cherryPick: 'Cherry pick',
  revert: 'Revert',
};

/** The operation in progress, else what one left behind; undefined when there is nothing to say. */
export function bannerOf(
  operation: OperationState | undefined,
  leftover: Leftover | undefined,
  facts: BannerFacts,
): Banner | undefined {
  if (operation) return stopped(operation, leftover, facts);
  if (!leftover) return undefined;
  const stash = `stash@{${leftover.kind === 'unmerged' ? (leftover.autostash?.index ?? 0) : leftover.stash.index}}`;
  const on = (label: string, command: CommandId, hash: string): BannerAction => ({
    label,
    command,
    context: { strataHash: hash },
  });
  switch (leftover.kind) {
    case 'restoreConflicted':
      return leftover.files.length > 0
        ? {
            state: 'leftover',
            warning: true,
            label: 'Stashed changes',
            parts: [
              `Restoring your stashed changes conflicted in ${fileList(leftover.files)}. They're safe in ${stash}.`,
            ],
            actions: [RESOLVE, on('Show Stash', 'strata.showStash', leftover.stash.hash)],
          }
        : {
            state: 'leftoverResolved',
            warning: false,
            label: 'Stashed changes',
            parts: [`Conflicts resolved. If all your changes are back, drop ${stash}.`],
            actions: [
              on('Drop Stash...', 'strata.stash.drop', leftover.stash.hash),
              on('Keep It', 'strata.keepStash', leftover.stash.hash),
            ],
          };
    case 'pendingStash':
      return {
        state: 'pending',
        warning: false,
        label: 'Stashed changes',
        parts: [
          `Strata stashed your changes before ${/^[aeiou]/.test(leftover.operation) ? 'an' : 'a'} ${leftover.operation} and hasn't restored them: ${stash}.`,
        ],
        actions: [
          on('Pop Stash', 'strata.stash.pop', leftover.stash.hash),
          on('Keep in Stash', 'strata.keepStash', leftover.stash.hash),
        ],
      };
    case 'unmerged': {
      const kept = leftover.autostash;
      return {
        state: 'conflicts',
        warning: true,
        label: 'Conflicts',
        parts: [
          `${plural(leftover.count, 'file')} ${leftover.count === 1 ? 'has' : 'have'} conflicts.`,
          ...(kept ? [` git kept stashed changes in ${stash} (autostash).`] : []),
        ],
        actions: [RESOLVE, ...(kept ? [on('Show Stash', 'strata.showStash', kept.hash)] : [])],
      };
    }
  }
}

const RESOLVE: BannerAction = { label: 'Resolve...', command: 'strata.resolveConflicts' };
const CONTINUE: BannerAction = { label: 'Continue', command: 'strata.operation.continue' };
const SKIP: BannerAction = { label: 'Skip...', command: 'strata.operation.skip' };
const ABORT: BannerAction = { label: 'Abort...', command: 'strata.operation.abort' };
const COMMIT_MERGE: BannerAction = { label: 'Commit Merge', command: 'strata.operation.continue' };

const short = (hash: string): BannerPart => ({ short: hash.slice(0, 7), hash });
const quote = (branch: string | undefined) => (branch === undefined ? 'HEAD' : `'${branch}'`);

function stopped(op: OperationState, leftover: Leftover | undefined, facts: BannerFacts): Banner {
  const conflicted = op.conflictCount > 0;
  const kind = conflicted ? 'stop' : facts.hadConflicts ? 'resolved' : 'stopped';
  const label = `${OPERATION_LABEL[op.kind]} in progress`;
  const conflicts = `: ${plural(op.conflictCount, 'conflicted file')}.`;
  const subject = op.applying === undefined ? undefined : facts.subject(op.applying);
  /** "ccccccc "Fix parser"", either part left out when unknown. */
  const commit = (): BannerPart[] =>
    op.applying === undefined ? [] : [short(op.applying), ...(subject === undefined ? [] : [` "${subject}"`])];
  const named = (hash: string | undefined): BannerPart[] => {
    const name = hash === undefined ? undefined : facts.name(hash);
    return name !== undefined ? [`'${name}'`] : hash !== undefined ? [short(hash)] : ['HEAD'];
  };
  const banner = (state: BannerState, parts: BannerPart[], actions: BannerAction[]): Banner => ({
    state,
    warning: kind === 'stop',
    label,
    parts,
    actions,
  });

  switch (op.kind) {
    case 'rebase': {
      const step = op.step;
      const at = step ? ` at ${step.current} of ${step.total}` : '';
      const rest = rebaseContinues(step);
      if (kind === 'stop') {
        const what: BannerPart[] =
          op.applying === undefined
            ? []
            : [...(subject === undefined ? [' ('] : [`, "${subject}" (`]), short(op.applying), ')'];
        return banner(
          'rebase',
          [
            `Rebasing ${quote(op.branch)} onto `,
            ...named(op.onto),
            ` stopped${at}`,
            ...what,
            conflicts,
            ...(op.branch === undefined
              ? []
              : [` ${quote(op.branch)} keeps its old commits until the rebase finishes.`]),
            ...(op.autostash
              ? [' Your uncommitted changes are held by git and come back when the rebase finishes or is aborted.']
              : []),
          ],
          [RESOLVE, CONTINUE, ABORT],
        );
      }
      const finishes: BannerPart[] =
        subject !== undefined ? [`"${subject}"`] : op.applying ? [short(op.applying)] : ['the stop'];
      if (kind === 'resolved')
        return banner(
          'rebaseResolved',
          ['Conflicts resolved. Continue finishes ', ...finishes, ` and ${rest}.`],
          [CONTINUE, ABORT],
        );
      const what: BannerPart[] =
        subject !== undefined ? [` ("${subject}")`] : op.applying !== undefined ? [' (', short(op.applying), ')'] : [];
      return banner('rebaseStopped', [`Rebase stopped${at}`, ...what, `. Continue ${rest}.`], [CONTINUE, ABORT]);
    }
    case 'merge': {
      if (kind === 'resolved')
        return banner('mergeResolved', ['Conflicts resolved. Commit Merge records the merge.'], [COMMIT_MERGE, ABORT]);
      const merging = ['Merging ', ...named(op.applying), ` into ${quote(op.branch)}`];
      if (kind === 'stopped')
        return banner('mergeStopped', [...merging, '. Commit Merge records the merge.'], [COMMIT_MERGE, ABORT]);
      return banner(
        'merge',
        [
          ...merging,
          conflicts,
          ...(op.autostash
            ? [' Your uncommitted changes are held by git and come back when the merge is committed or aborted.']
            : []),
        ],
        [RESOLVE, COMMIT_MERGE, ABORT],
      );
    }
    case 'cherryPick':
    case 'revert': {
      const pick = op.kind === 'cherryPick';
      const doing = [
        pick ? 'Cherry picking ' : 'Reverting ',
        ...commit(),
        ` ${pick ? 'onto' : 'on'} ${quote(op.branch)}`,
      ];
      const noun = pick ? 'cherry pick' : 'revert';
      if (op.empty && !conflicted)
        return banner(
          'sequencerEmpty',
          [...doing, ' has nothing left to commit: its changes are already there. Skip leaves it out.'],
          [SKIP, ABORT],
        );
      if (op.remaining !== undefined && !conflicted) {
        const rest =
          op.remaining > 0
            ? `${pick ? 'cherry picks' : 'reverts'} the remaining ${plural(op.remaining, 'commit')}`
            : `finishes the ${noun}`;
        return banner(
          'sequencerBetween',
          [
            `${pick ? 'Cherry picking onto' : 'Reverting on'} ${quote(op.branch)} stopped between commits. Continue ${rest}.`,
          ],
          [CONTINUE, ABORT],
        );
      }
      if (kind === 'resolved')
        return banner(
          'sequencerResolved',
          [`Conflicts resolved. Continue commits the ${noun}.`],
          [CONTINUE, SKIP, ABORT],
        );
      if (kind === 'stopped')
        return banner(
          'sequencerStopped',
          [...doing, ' stopped. Continue commits it; Skip leaves it out.'],
          [CONTINUE, SKIP, ABORT],
        );
      const held =
        leftover?.kind === 'pendingStash'
          ? [
              ` Your uncommitted changes are in stash@{${leftover.stash.index}} (Strata autostash); Strata restores them when you continue or abort here.`,
            ]
          : [];
      return banner('sequencer', [...doing, conflicts, ...held], [RESOLVE, CONTINUE, SKIP, ABORT]);
    }
  }
}
