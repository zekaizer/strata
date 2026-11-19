import * as vscode from 'vscode';
import { lineGlyphs, type LineChange, type LineGlyph, type SideMarkers } from '../core/change-markers.ts';

const RULER: Record<LineChange, string> = {
  added: 'editorOverviewRuler.addedForeground',
  modified: 'editorOverviewRuler.modifiedForeground',
  removed: 'editorOverviewRuler.deletedForeground',
};
/** What the webview reports as `--vscode-editorGutter-*`: a computed color, nothing that could break out of the SVG. */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i;

/** How the user has VS Code draw its own quick diff markers, so these match them. */
interface Style {
  colors: Record<LineChange, string>;
  /** `scm.diffDecorationsGutterWidth`, 1 to 5. */
  width: number;
  /** `scm.diffDecorationsGutterPattern`: hatched instead of solid. */
  pattern: Record<'added' | 'modified', boolean>;
}

function readStyle(colors: Record<LineChange, string>): Style {
  const scm = vscode.workspace.getConfiguration('scm');
  const width = scm.get<number>('diffDecorationsGutterWidth', 3);
  const pattern = scm.get<Partial<Record<'added' | 'modified', boolean>>>('diffDecorationsGutterPattern', {});
  return {
    colors,
    width: Number.isInteger(width) ? Math.min(Math.max(width, 1), 5) : 3,
    pattern: { added: pattern.added ?? false, modified: pattern.modified ?? true },
  };
}

/**
 * The glyph as an SVG for the 18-unit square VS Code stretches over a line's glyph margin. The bar
 * keeps to the margin's right, next to the line numbers; a gap's triangle is split between the two
 * lines it lies between, so the halves meet on their boundary.
 */
function glyphSvg(g: LineGlyph, style: Style): string {
  const x = 17 - style.width;
  const parts: string[] = [];
  if (g.bar) {
    const color = style.colors[g.bar];
    const hatched = g.bar !== 'removed' && style.pattern[g.bar];
    if (hatched)
      parts.push(
        `<defs><pattern id="h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
          `<rect width="2" height="4" fill="${color}"/></pattern></defs>`,
      );
    parts.push(`<rect x="${x}" width="${style.width}" height="18" fill="${hatched ? 'url(#h)' : color}"/>`);
  }
  if (g.top) parts.push(`<polygon points="${x},0 ${x},4 ${x + 4},0" fill="${style.colors[g.top]}"/>`);
  if (g.bottom) parts.push(`<polygon points="${x},14 ${x},18 ${x + 4},18" fill="${style.colors[g.bottom]}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" preserveAspectRatio="none">${parts.join('')}</svg>`;
}

/**
 * Marks the lines a commit changed in the versions of a file Strata opens (design system: the
 * editor's change markers), in the glyph margin: the gutter next to the line numbers, where quick
 * diff draws, is not open to extensions, and anything drawn in the text area covers or moves the
 * text. Markers belong to a document, not an editor: they come back when its tab is shown again,
 * and the last file opened as that document decides them.
 */
export class ChangeMarkerDecorations implements vscode.Disposable {
  /** Decoration types by glyph; theme colors are only known once the webview has reported them. */
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private colors: Record<LineChange, string> | undefined;
  private style: Style | undefined;
  private readonly byDocument = new Map<string, SideMarkers>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.decorate(editor);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.byDocument.delete(doc.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('scm.diffDecorationsGutterWidth') ||
          e.affectsConfiguration('scm.diffDecorationsGutterPattern')
        )
          this.restyle();
      }),
    );
  }

  /** Marks `uri`'s editors with `markers` from now on, those on screen at once. */
  show(uri: vscode.Uri, markers: SideMarkers): void {
    this.byDocument.set(uri.toString(), markers);
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
  }

  /** Takes the theme's quick diff colors; ones that are not colors leave the markers as they are. */
  setColors(colors: Record<LineChange, string>): void {
    if (!Object.values(colors).every((c) => COLOR.test(c))) return;
    this.colors = colors;
    this.restyle();
  }

  /** The markers `uri`'s editors get; for tests. */
  markersOf(uri: vscode.Uri): SideMarkers | undefined {
    return this.byDocument.get(uri.toString());
  }

  private restyle(): void {
    if (!this.colors) return;
    this.style = readStyle(this.colors);
    for (const t of this.types.values()) t.dispose();
    this.types.clear();
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
  }

  private type(g: LineGlyph, style: Style): vscode.TextEditorDecorationType {
    const key = `${g.bar ?? ''}|${g.top ?? ''}|${g.bottom ?? ''}`;
    let type = this.types.get(key);
    if (!type) {
      const ruler = g.bar ?? g.top ?? g.bottom;
      type = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(glyphSvg(g, style))}`),
        gutterIconSize: '100% 100%',
        ...(ruler && {
          overviewRulerColor: new vscode.ThemeColor(RULER[ruler]),
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
      });
      this.types.set(key, type);
    }
    return type;
  }

  private decorate(editor: vscode.TextEditor): void {
    const markers = this.byDocument.get(editor.document.uri.toString());
    const style = this.style;
    if (!markers || !style) return;
    // Every type is set, the unused ones empty, so a glyph the editor showed before goes away.
    const ranges = new Map([...this.types.values()].map((t) => [t, [] as vscode.Range[]]));
    for (const [line, g] of lineGlyphs(markers, editor.document.lineCount)) {
      const type = this.type(g, style);
      const r = ranges.get(type) ?? [];
      ranges.set(type, r);
      r.push(editor.document.lineAt(line).range);
    }
    for (const [type, r] of ranges) editor.setDecorations(type, r);
  }

  dispose(): void {
    for (const d of [...this.disposables, ...this.types.values()]) d.dispose();
  }
}
