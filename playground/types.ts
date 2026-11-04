import type { Commit } from '../src/core/commit.ts';
import type { CommitDetails } from '../src/core/details.ts';
import type { RefSnapshot } from '../src/core/refs.ts';
import type { RepoInfo } from '../src/shared/protocol.ts';

export interface PlaygroundData {
  repo: RepoInfo;
  refs: RefSnapshot;
  commits: Commit[];
  details: Record<string, CommitDetails>;
}
