/**
 * What each element of the graph writes into data-vscode-context. VS Code merges an element's
 * context over its ancestors' (a badge's menu also sees its row's keys) and passes the result,
 * plus `webview`, to the webview/context command. Commands get it from the webview, so the host
 * validates every value.
 */
export interface CommitContext {
  webviewSection: 'commit';
  preventDefaultContextMenuItems: true;
  strataHash: string;
  strataSubject: string;
  strataIsHead: boolean;
  strataHasRefs: boolean;
  /** Full names of the refs on the commit, space-separated, those collapsed into "+N" included. */
  strataRefs: string;
  /**
   * Full name of the one local branch on the commit other than the current one, else empty:
   * the row's Checkout, Merge and Rebase act on it instead of on the commit.
   */
  strataBranch: string;
}

export interface StashContext {
  webviewSection: 'stash';
  preventDefaultContextMenuItems: true;
  /** The stash commit. */
  strataHash: string;
  /** The reflog subject. */
  strataSubject: string;
  /** Restoring this stash conflicted: applying it again would apply the changes twice. */
  strataLeftover: boolean;
}

/** A badge, or a remote name inside a branch's badge; `strataHash` is the commit it is on. */
export type BadgeContext =
  | {
      webviewSection: 'branch';
      strataHash: string;
      /** Full name, e.g. refs/heads/main. */
      strataRef: string;
      strataIsCurrent: boolean;
      strataUpstream: boolean;
    }
  | { webviewSection: 'remoteBranch' | 'tag'; strataHash: string; strataRef: string }
  /** A detached HEAD. */
  | { webviewSection: 'head'; strataHash: string }
  /** "+N", or "+k" remote names: the refs it stands for, space-separated. */
  | { webviewSection: 'refs'; strataHash: string; strataRefs: string };
