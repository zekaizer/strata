import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

/** Commit handle: the fast-import mark number. */
export type Mark = number;

interface CommitSpec {
  ref: string;
  message: string;
  parents: Mark[];
  /** Seconds since the builder epoch; decides committer and author dates. */
  time: number;
  author: string;
  files: Record<string, string>;
}

const SCRATCH = 'refs/strata-fixture/scratch';
export const EPOCH = 1_700_000_000; // 2023-11-14T22:13:20Z, fixed so object ids are stable.

/**
 * Builds a repository history in memory and materializes it with
 * `git fast-import`. Same calls produce the same object ids on any git version.
 */
export class RepoBuilder {
  private readonly commits: CommitSpec[] = [];
  private readonly refs = new Map<string, Mark>();
  private readonly tags: { name: string; target: Mark; message: string | undefined }[] = [];
  private clock = 0;
  private head = 'refs/heads/main';
  private readonly remoteNames: string[] = [];
  private readonly afterWrites: ((dir: string) => void)[] = [];

  /**
   * Adds a commit on `branch`. Parents default to the branch tip; pass
   * `parents` to override (empty array makes a root commit).
   */
  commit(
    branch: string,
    message: string,
    opts: { parents?: Mark[]; files?: Record<string, string>; author?: string; time?: number } = {},
  ): Mark {
    const ref = qualify(branch);
    const tip = this.refs.get(ref);
    const parents = opts.parents ?? (tip === undefined ? [] : [tip]);
    this.clock = opts.time ?? this.clock + 60;
    const mark = this.commits.length + 1;
    this.commits.push({
      ref,
      message,
      parents,
      time: this.clock,
      author: opts.author ?? 'Ada Lovelace <ada@example.com>',
      files: opts.files ?? { [`${branch.replaceAll('/', '_')}.txt`]: `${message}\n` },
    });
    this.refs.set(ref, mark);
    return mark;
  }

  /** Merge commit on `branch` whose first parent is the branch tip. Changes no files beyond the merge itself. */
  merge(branch: string, others: Mark[], message?: string): Mark {
    const tip = this.tip(branch);
    return this.commit(branch, message ?? `Merge ${others.length} parent(s) into ${branch}`, {
      parents: [tip, ...others],
      files: {},
    });
  }

  /** Creates or moves a ref (branch, remote-tracking branch, ...) to `target`. */
  ref(name: string, target: Mark): this {
    this.refs.set(qualify(name), target);
    return this;
  }

  /** Lightweight tag when `message` is undefined, annotated otherwise. */
  tag(name: string, target: Mark, message?: string): this {
    this.tags.push({ name, target, message });
    return this;
  }

  /** Configures a remote (no URL is needed for refs/remotes/<name>/* to mean something to git). */
  remote(name: string): this {
    this.remoteNames.push(name);
    return this;
  }

  /** Runs `step` on the written repository, after the history and refs are in place. */
  afterWrite(step: (dir: string) => void): this {
    this.afterWrites.push(step);
    return this;
  }

  setHead(branch: string): this {
    this.head = qualify(branch);
    return this;
  }

  tip(branch: string): Mark {
    const m = this.refs.get(qualify(branch));
    if (m === undefined) throw new Error(`unknown branch ${branch}`);
    return m;
  }

  /** The fast-import stream. Exposed for tests. */
  stream(): string {
    const out: string[] = [];
    const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
    // File contents per commit. A merge takes the union of its parents' files
    // (earlier parents win on conflicting paths), like a conflict-free merge.
    const trees: Map<string, string>[] = [];
    this.commits.forEach((c, i) => {
      const mark = i + 1;
      const when = `${EPOCH + c.time} +0000`;
      const [first, ...rest] = c.parents;
      // Commits go to a scratch ref; real refs are set with `reset` below.
      // Without `from`, fast-import would parent a commit on the scratch ref's tip, so root commits reset it first.
      if (first === undefined) out.push(`reset ${SCRATCH}\n\n`);
      out.push(`commit ${SCRATCH}\nmark :${mark}\n`);
      out.push(`author ${c.author} ${when}\ncommitter ${c.author} ${when}\n`);
      out.push(data(c.message));
      if (first !== undefined) out.push(`from :${first}\n`);
      for (const p of rest) out.push(`merge :${p}\n`);
      const base = first === undefined ? new Map<string, string>() : trees[first - 1]!;
      const tree = new Map(base);
      for (const p of rest) for (const [path, content] of trees[p - 1]!) if (!tree.has(path)) tree.set(path, content);
      for (const [path, content] of Object.entries(c.files)) tree.set(path, content);
      trees.push(tree);
      // fast-import starts from the first parent's tree; write only what differs from it.
      for (const [path, content] of tree) {
        if (base.get(path) !== content) out.push(`M 100644 inline ${path}\n${data(content)}`);
      }
      out.push('\n');
    });
    for (const [ref, mark] of this.refs) out.push(`reset ${ref}\nfrom :${mark}\n\n`);
    for (const t of this.tags) {
      if (t.message === undefined) {
        out.push(`reset refs/tags/${t.name}\nfrom :${t.target}\n\n`);
      } else {
        const when = `${EPOCH + this.commits[t.target - 1]!.time + 1} +0000`;
        out.push(
          `tag ${t.name}\nfrom :${t.target}\ntagger Release Bot <release@example.com> ${when}\n${data(t.message)}`,
        );
      }
    }
    return out.join('');
  }

  /** Writes the repository to `dir` (replacing it) and checks out HEAD. */
  write(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const git = (args: string[], input?: string) =>
      execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
        cwd: dir,
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    git(['init', '--quiet']);
    git(['fast-import', '--quiet', '--done'], this.stream() + 'done\n');
    git(['update-ref', '-d', SCRATCH]);
    git(['symbolic-ref', 'HEAD', this.head]);
    git(['checkout', '--quiet', '--force']);
    for (const r of this.remoteNames) git(['remote', 'add', r, `https://example.com/${r}.git`]);
    for (const step of this.afterWrites) step(dir);
  }
}

function qualify(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}
