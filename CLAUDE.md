# Strata — agent notes

- Clean-room: never read or copy code from mhutchie/vscode-git-graph or its forks.
- Test data: synthetic fixture repos and public repos only.
- `src/core` must stay pure (no `vscode`, no DOM, no Node I/O) — it runs in both the extension host and the layout worker.
- Relative imports use explicit `.ts` extensions; only erasable TS syntax (no enums, namespaces, parameter properties).
- Before committing: `npm run check`; for host/webview changes also `npm run test:integration`.
- Visual changes: verify with `npm run playground:shot` and `npm run shot`, and look at the PNGs.
