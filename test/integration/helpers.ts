import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';

export async function strata(): Promise<StrataTestApi> {
  const ext = vscode.extensions.getExtension<StrataTestApi>('inhouse.strata');
  if (!ext) throw new Error('extension inhouse.strata not found');
  return ext.activate();
}

export const THEMES = {
  dark: 'Default Dark Modern',
  light: 'Default Light Modern',
  'high-contrast': 'Default High Contrast',
  'high-contrast-light': 'Default High Contrast Light',
} as const;

export type ThemeId = keyof typeof THEMES;

/** Switches the color theme and resolves after VS Code reports the change. */
export async function setTheme(id: ThemeId): Promise<void> {
  const name = THEMES[id];
  const config = vscode.workspace.getConfiguration('workbench');
  if (config.get('colorTheme') === name) return;
  const changed = new Promise<void>((resolve) => {
    const sub = vscode.window.onDidChangeActiveColorTheme(() => {
      sub.dispose();
      resolve();
    });
  });
  await config.update('colorTheme', name, vscode.ConfigurationTarget.Global);
  await changed;
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Captures the whole X display. Requires DISPLAY (scripts/xvfb.mjs) and ImageMagick. */
export async function screenshot(file: string): Promise<void> {
  await promisify(execFile)('import', ['-window', 'root', file]);
}
