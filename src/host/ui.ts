import * as vscode from 'vscode';
import type { Confirmation } from '../core/wording.ts';

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

/**
 * The questions flows ask. VS Code's modals cannot be answered from integration tests, so tests
 * replace this with scripted answers (StrataTestApi.setUi).
 */
export interface Ui {
  /** The id of the chosen button, or undefined for Cancel. */
  confirm<B extends string>(c: Confirmation<B>): Promise<B | undefined>;
  input(o: {
    title: string;
    prompt: string;
    value?: string;
    /** false puts the cursor after `value` (a prefix to continue) instead of selecting it. */
    selectValue?: boolean;
    placeholder?: string;
    validate: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  pick<T>(o: { title: string; placeholder?: string; items: PickItem<T>[] }): Promise<T | undefined>;
  /** A non-modal message with optional action buttons; resolves with the clicked one. */
  notify(level: 'info' | 'warning' | 'error', message: string, ...actions: string[]): Promise<string | undefined>;
}

export const vscodeUi: Ui = {
  async confirm(c) {
    const show = c.level === 'info' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    const choice = await show(c.message, { modal: true, detail: c.detail }, ...c.buttons.map((b) => b.label));
    return c.buttons.find((b) => b.label === choice)?.id;
  },
  input(o) {
    return Promise.resolve(
      vscode.window.showInputBox({
        title: o.title,
        prompt: o.prompt,
        ...(o.value === undefined ? {} : { value: o.value }),
        ...(o.value !== undefined && o.selectValue === false
          ? { valueSelection: [o.value.length, o.value.length] as [number, number] }
          : {}),
        ...(o.placeholder === undefined ? {} : { placeHolder: o.placeholder }),
        validateInput: o.validate,
        ignoreFocusOut: true,
      }),
    );
  },
  async pick(o) {
    const choice = await vscode.window.showQuickPick(o.items, {
      title: o.title,
      ...(o.placeholder === undefined ? {} : { placeHolder: o.placeholder }),
      matchOnDescription: true,
    });
    return choice?.value;
  },
  notify(level, message, ...actions) {
    const show =
      level === 'error'
        ? vscode.window.showErrorMessage
        : level === 'warning'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    return Promise.resolve(show(message, ...actions));
  },
};
