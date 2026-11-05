import type * as vscode from 'vscode';
import { parseRules, type BadgeRule } from '../core/badge-rules.ts';

/** globalState key of the badge rules, by the absolute git common dir of the repository. */
const KEY = 'strata.badgeRules';
/** Writes tried before giving up on a value reading back. */
const ATTEMPTS = 3;

/**
 * Each repository's badge rules, kept in globalState: every worktree, workspace and window opening
 * the repository shares them. This window's copy is the authority while it runs.
 *
 * VS Code replaces an extension's whole memento with the echo of an earlier write when that echo
 * lands between a later update and its flush, so a quick second change could be lost: reads come
 * from the copy here, and a write is repeated until it reads back.
 */
export class BadgeRuleStore {
  private readonly memento: vscode.Memento;
  private all: Record<string, unknown> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  get(commonDir: string): BadgeRule[] {
    return parseRules(this.read()[commonDir]);
  }

  /** Replaces the rules of a repository; resolves once they are stored. */
  set(commonDir: string, rules: readonly BadgeRule[]): Promise<void> {
    const all = { ...this.read() };
    if (rules.length > 0) all[commonDir] = rules;
    else Reflect.deleteProperty(all, commonDir);
    this.all = all;
    this.writing = this.writing.catch(() => undefined).then(() => this.persist());
    return this.writing;
  }

  private read(): Record<string, unknown> {
    return (this.all ??= { ...this.memento.get<Record<string, unknown>>(KEY) });
  }

  private async persist(): Promise<void> {
    for (let i = 0; i < ATTEMPTS; i++) {
      const all = this.all;
      await this.memento.update(KEY, all);
      if (JSON.stringify(this.memento.get(KEY)) === JSON.stringify(this.all)) return;
    }
  }
}
