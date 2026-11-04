import type { Commit } from '../src/core/commit.ts';
import type { CommitDetails } from '../src/core/details.ts';
import type { RefSnapshot } from '../src/core/refs.ts';
import type { StashEntry } from '../src/core/stash.ts';
import type { RepoInfo } from '../src/shared/protocol.ts';

export interface PlaygroundData {
  repo: RepoInfo;
  refs: RefSnapshot;
  stashes: StashEntry[];
  commits: Commit[];
  details: Record<string, CommitDetails>;
}
