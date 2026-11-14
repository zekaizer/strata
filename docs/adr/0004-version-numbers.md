# 4. Version numbers of releases and pre-releases

Date: 2026-11-14

## Status

Accepted

## Context

CI builds are meant to be published to the Marketplace as pre-releases. Their version was
`<version>-ci.<run>`, and the Marketplace refuses it: a version there is one to four numbers
separated by periods, with no semver pre-release suffix.

The Marketplace keeps releases and pre-releases in one version space: no version can be published
twice, and VS Code gives a user who opted into pre-releases whichever of the two is higher. VS Code's
documentation recommends an even minor version for releases and an odd one for pre-releases.

`0.1.0` is already published as a release.

## Decision

- A release has an even minor version: `x.(2n).z`. The next release is `0.2.0`; `0.1.0` stays as the
  one exception.
- A pre-release has an odd minor version: the first odd number above the minor version in
  `package.json`, with the CI run number as its patch. `0.2.0` in `package.json` gives `0.3.<run>`.
  CI stamps every build that way; the run number keeps each one unique.
- The release workflow refuses a GitHub release whose minor version does not match its kind: odd for
  a pre-release, even otherwise.

## Consequences

- Every CI build can be uploaded to the Marketplace as a pre-release as it is.
- Pre-release users stay ahead of releases: `0.3.x` builds sort above `0.2.x` releases, and the next
  release with a higher minor (`0.4.0`) takes them back to the release line.
- The version no longer says it is a CI build; the build note in the README and the `--pre-release`
  flag do.
- A release bumps the minor version by two.
