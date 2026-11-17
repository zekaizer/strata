# 6. Pre-release patch numbers

Date: 2026-11-18

## Status

Accepted

Supersedes the pre-release patch number and the next release of [ADR 4](0004-version-numbers.md).

## Context

ADR 4 numbers a CI build `<major>.<first odd minor above the release's>.<CI run number>`. The run
number grows with every run of every branch, so the builds of `main` read `0.3.60`, `0.3.64`,
`0.3.67`: the number says nothing about the build and skips unpredictably.

ADR 4 also named `0.2.0` as the release after `0.1.0`. But CI builds of `0.1.0` were `0.3.x`, and
`0.3.x` pre-releases were already on the Marketplace, so `0.2.0` was published below them and
pre-release users never got it. The release after them was `0.4.0`.

A patch release has to stay possible while pre-releases of the next minor are out: `0.4.1` after
`0.5.x` builds.

## Decision

- A CI build's patch number is the number of commits on its branch since the commit that set
  `package.json` to `<major>.<minor>.0` of the release it builds on. Three commits after `0.4.0`
  give `0.5.3`. A patch release (`0.4.1`) does not restart the count, so builds after it stay above
  those before it. `main` only moves forward, so its builds' numbers only grow.
- The release after the pre-releases of a minor is the next even minor: after `0.5.x`, `0.6.0`.
- A version is checked against the Marketplace before it is attached to a GitHub release and again
  before it is published: a pre-release must be above every published version; a release above
  every published release, and one that starts a minor (`x.y.0`) above every published
  pre-release too. A patch release may stay below the next minor's pre-releases: release users get
  it, pre-release users keep the newer builds.

## Consequences

- CI needs the history back to that commit, not a shallow clone.
- Builds of different branches can share a version; only builds of `main` are published.
- Two runs of the same commit give the same version; the Marketplace takes it once.
