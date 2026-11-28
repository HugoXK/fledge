# 0029 — coverage measurement: a measured line is executable code, and the type/value boundary is decided on the line

Status: **accepted** (implemented in the same pull request as [`#1313`](https://github.com/HugoXK/fledge/issues/1313))
Date: 2026-11-28
Decision owner: Fledge Platform Dev-2
Settles: [`#1313`](https://github.com/HugoXK/fledge/issues/1313), which folds in the Lead's four T3 conditions. It records the rule the classifier applies and rejects the alternative that card named.
Pin: `4099d7f85df8ba801edf0fbbc6ff7b4350ca41da` — every `file:line` here resolves at it.

## Context

`scripts/lib/coverage-diff.mjs` decides which added `src/**` lines the
changed-lines floor measures. Its classifier was a keyword list: comments,
`import`, and lines opening `type`/`interface`/`declare`/`namespace` were exempt.
That list was wrong in both directions.

- **False positive.** A TypeScript interface member standing alone
  (`instancesUsed: boolean`) is measured, because the list only exempts a line
  that *opens* a declaration. The #1302 coverage job refused an honest one-file
  refactor for a line no test can execute, and it went green only when the same
  member was moved onto a one-line `export interface`.
- **False negative.** A one-line `namespace` body that runs code and a dynamic
  `import(...)` call are skipped by the same list. A diff of only those lines
  measures nothing, and `scripts/coverage-diff.mjs` turns `measured: 0` into a
  green `skip` (exit 0) while the report the same run produced lists both lines
  as uncovered.

The module's original rationale — "a line the report does not list has nothing
for a test to execute" — is the assumption the #1302 log falsified: the report
can list a type-only line.

## Decision

The classifier stays line-level (the card's resolution 2); the file text and the
enclosing block are not read.

1. **A declaration member is not measured only when its right-hand side is a
   type expression.** `name: Type`, with optional `readonly`/`?` and optional
   `,`/`;`, is exempt when `Type` is a built-in type keyword or a capitalized
   type name, including arrays, generics and unions. A line whose right-hand side
   is a string or numeric literal, a call, an operator or a lowercase identifier
   stays measured: those are values far more often than lowercase type aliases,
   and the pair (`instancesUsed: boolean` unmeasured, `key: 'instance',`
   measured) is the boundary the review checks.
2. **A one-line `namespace` body is measured when the line retains statements
   after `{`.** A namespace header alone and an empty body declare only.
3. **Static imports stay unmeasured; `import(` and `import.meta` are measured.**
   A dynamic import runs code, and `import.meta` is an expression.
4. **Nothing else moves.** The report parser, the `No-test:` waiver and the floor
   are unchanged, a file the report does not list still fails closed, and
   `NO_SOURCE_LINES`/`skip` must not be reachable on a diff of executable lines —
   the end-to-end test in `test/coverageDiff.test.ts` is that guard.

## Alternatives

- **Keep the classifier and document the trap only.** Rejected: a documented trap
  does not bind the gate. `scripts/coverage-diff.mjs` still exits 0 on a diff
  whose own report lists every added line as uncovered, and #1302's false
  positive still turns a formatting change into a coverage failure.
- **Resolve the enclosing block from the file at head** (the card's resolution
  1). Not taken in this slice: it changes the CLI to pass file text and widens
  the classifier's input for the same type/value judgement a line-level rule
  makes. The residual below is where it would pay off, and it can replace this
  rule later without changing the contract.

## Consequences

- The residual is explicit: a lowercase type alias (`id: uuid`) is measured, and
  an object literal whose value is a capitalized identifier (`node:
  SomeComponent`) is not. Both are rarer than the two errors this closes, and
  either can be corrected by the block-resolving alternative above.
- The rule is checkable by reading the one line it is given, which is what lets
  the red tests stay line-level.
- This is gate contract, so a future change to this rule is a T3 diff with a PASS
  at its tip; the tests in `test/coverageDiff.test.ts` name every case the
  contract has to keep.
