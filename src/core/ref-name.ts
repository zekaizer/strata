/** Characters git never allows in a ref name (check-ref-format rules 3-5 and 9). */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/\s/, "Names can't contain spaces."],
  [/[~^:?*[\\]/, "Names can't contain ~ ^ : ? * [ or \\."],
  [/\.\./, "Names can't contain '..'."],
  [/@\{/, "Names can't contain '@{'."],
  [/\/\//, "Names can't contain '//'."],
];

/**
 * Why `name` is not a valid branch or tag name, or undefined when it is: the names `git branch`
 * and `git tag` accept. Checked as the user types, without running git.
 */
export function refNameProblem(name: string): string | undefined {
  if (name === '') return 'Enter a name.';
  if (name.startsWith('-')) return "Names can't start with '-'.";
  if (name === 'HEAD') return "'HEAD' is reserved.";
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return "Names can't contain control characters.";
  }
  for (const [pattern, problem] of FORBIDDEN) if (pattern.test(name)) return problem;
  if (name.startsWith('/') || name.endsWith('/')) return "Names can't start or end with '/'.";
  if (name.endsWith('.')) return "Names can't end with '.'.";
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return "No part of a name can start with '.'.";
    if (part.endsWith('.lock')) return "No part of a name can end with '.lock'.";
  }
  return undefined;
}
