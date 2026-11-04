import type { Confirmation } from '../../src/core/wording.ts';
import type { PickItem, Ui } from '../../src/host/ui.ts';

export type Question =
  | { kind: 'confirm'; message: string; detail: string; buttons: string[] }
  | { kind: 'input'; title: string; prompt: string; value: string | undefined; problem: string | undefined }
  | { kind: 'pick'; title: string; items: string[] }
  | { kind: 'notify'; level: 'info' | 'warning' | 'error'; message: string; actions: string[] };

/**
 * Answers the questions flows ask from queues, and records every question. An empty queue
 * cancels a modal, an input or a pick, and dismisses a notification.
 */
export class ScriptedUi implements Ui {
  readonly asked: Question[] = [];
  private confirms: (string | undefined)[] = [];
  private inputs: (string | undefined)[] = [];
  private picks: (string | undefined)[] = [];
  private clicks: (string | undefined)[] = [];

  /** Labels of the buttons to press in the next modals. */
  press(...labels: (string | undefined)[]): this {
    this.confirms.push(...labels);
    return this;
  }

  /** Texts to enter in the next input boxes. */
  type(...texts: (string | undefined)[]): this {
    this.inputs.push(...texts);
    return this;
  }

  /** Labels of the items to pick in the next quick picks. */
  choose(...labels: (string | undefined)[]): this {
    this.picks.push(...labels);
    return this;
  }

  /** Actions to click on the next notifications. */
  click(...actions: (string | undefined)[]): this {
    this.clicks.push(...actions);
    return this;
  }

  clear(): void {
    this.asked.length = 0;
    this.confirms = [];
    this.inputs = [];
    this.picks = [];
    this.clicks = [];
  }

  /** Questions of one kind, in the order asked. */
  of<K extends Question['kind']>(kind: K): Extract<Question, { kind: K }>[] {
    return this.asked.filter((q): q is Extract<Question, { kind: K }> => q.kind === kind);
  }

  /** The first question of one kind; throws when none was asked. */
  first<K extends Question['kind']>(kind: K): Extract<Question, { kind: K }> {
    const q = this.of(kind)[0];
    if (!q) throw new Error(`no ${kind} was asked; asked: ${JSON.stringify(this.asked)}`);
    return q;
  }

  confirm<B extends string>(c: Confirmation<B>): Promise<B | undefined> {
    this.asked.push({ kind: 'confirm', message: c.message, detail: c.detail, buttons: c.buttons.map((b) => b.label) });
    const label = this.confirms.shift();
    if (label === undefined) return Promise.resolve(undefined);
    const button = c.buttons.find((b) => b.label === label);
    if (!button)
      throw new Error(`no button "${label}" in "${c.message}" (${c.buttons.map((b) => b.label).join(', ')})`);
    return Promise.resolve(button.id);
  }

  input(o: Parameters<Ui['input']>[0]): Promise<string | undefined> {
    const text = this.inputs.shift();
    const problem = text === undefined ? undefined : o.validate(text);
    this.asked.push({ kind: 'input', title: o.title, prompt: o.prompt, value: o.value, problem });
    return Promise.resolve(problem === undefined ? text : undefined);
  }

  pick<T>(o: { title: string; placeholder?: string; items: PickItem<T>[] }): Promise<T | undefined> {
    this.asked.push({ kind: 'pick', title: o.title, items: o.items.map((i) => i.label) });
    const label = this.picks.shift();
    if (label === undefined) return Promise.resolve(undefined);
    const item = o.items.find((i) => i.label === label);
    if (!item) throw new Error(`no item "${label}" in "${o.title}"`);
    return Promise.resolve(item.value);
  }

  notify(level: 'info' | 'warning' | 'error', message: string, ...actions: string[]): Promise<string | undefined> {
    this.asked.push({ kind: 'notify', level, message, actions });
    return Promise.resolve(this.clicks.shift());
  }
}
