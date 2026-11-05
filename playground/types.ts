import type { Commit } from '../src/core/commit.ts';
import type { CommitDetails } from '../src/core/details.ts';
import type { PathOrigin } from '../src/core/path-filter.ts';
import type { RefSnapshot } from '../src/core/refs.ts';
import type { StashEntry } from '../src/core/stash.ts';
import type { Where } from '../src/core/where.ts';
import type { RepoInfo } from '../src/shared/protocol.ts';

export interface PlaygroundData {
  repo: RepoInfo;
  refs: RefSnapshot;
  stashes: StashEntry[];
  commits: Commit[];
  details: Record<string, CommitDetails>;
  /** Where the first commits are, as the host answers whereIs with no badge rules. */
  where: Record<string, Where>;
  /** Path histories read with the real readers, by their paths joined with ','. */
  paths?: Record<string, { commits: Commit[]; unchanged: string[]; origin: PathOrigin }>;
}
