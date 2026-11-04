export type RefKind = 'branch' | 'remote' | 'tag' | 'stash';

export interface Ref {
  /** Full name, e.g. refs/heads/main. */
  name: string;
  /** Display name, e.g. main, origin/main, v1.0. */
  short: string;
  kind: RefKind;
  /** Commit the ref points at (annotated tags are peeled). */
  hash: string;
}

export interface RefSnapshot {
  /** Commit HEAD points at; undefined on an unborn branch. */
  head: string | undefined;
  /** Branch HEAD is on (short name); undefined when detached or unborn. */
  headBranch: string | undefined;
  refs: Ref[];
}
