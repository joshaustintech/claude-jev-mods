# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code mod (plugin `jev`, in `jev/`) that calls Jev 1.14 (TypeSafe's decision model, via OpenRouter's `https://openrouter.ai/api/alpha/decisions`) to route prompts and subagents between Opus, Sonnet and Haiku, and to block credential reads and off-task source reads. It is inert and silent when `OPENROUTER_API_KEY` is unset. `README.md` describes the behavior users see; keep it in sync when that behavior changes.

## Commands

```
npm install
npm run check        # typecheck + lint:adt + validate + test, in that order
npm run lint:adt     # data-model lint (scripts/lint-adt.mjs)
npm run validate     # claude plugin validate jev
npm test             # claude plugin test jev
npm run typecheck    # tsc -p jev
claude --plugin-dir ./jev   # run the mod from this checkout
```

- `claude plugin test` runs every `*.test.ts(x)` under `jev/`, each file in its own child process. It has no filter flag, so there is no way to run a single test or file on its own; run the whole suite.
- `npm run typecheck` needs the engine's declarations in `jev/.claude-plugin/types/`, which Claude Code writes the first time it loads the mod with `claude --plugin-dir ./jev`. Without them, typecheck fails on `claude-code` imports. That is a missing setup step, not a bug in the code.

## Architecture

The code is layered so that everything except the wiring is pure:

- `jev/types/index.d.ts`: the whole data model, plus the `$.state` contract (`PluginState.jev.ledger`). Read it first.
- `jev/hooks/boundary.ts`: the only place untyped data enters. It decodes engine events, `fs.stat`, env (`OPENROUTER_API_KEY`, and `HOME`/`USERPROFILE` for `homeDir`), session usage and Jev HTTP replies into model types (`decodeDecided` checks each reply against the questions that were asked). It is the only file allowed to touch `null`, `undefined`, `unknown` or casts.
- `jev/hooks/domain.ts`: constructors (`some`/`none`/`ok`/`err`), branded-scalar guards (`probability`, `tokens`, `usd`, ...), `absurd` for exhaustive matches, noul reading (`readNoul` with a `Band`), and ledger transitions (`wake`, `applyDecision`, `viewOf`).
- `jev/hooks/decisions.ts`: the Jev client. `noul`/`choice` build typed questions, and `decide` returns `Result<Decided<Qs>, JevError>`, with answers typed per question via `AnswersOf<Qs>`.
- `jev/hooks/shell.ts`: reads a command line as the shell would (`segmentsOf`): quotes respected, each `$(...)`/backtick a segment of its own, heredoc bodies kept with the command that reads them. It never runs anything.
- `jev/hooks/guard.ts`: credential rules that need no model call (`pathRule`, `commandRule`, `ruleFor`), which give each word of a command a role so that message text and search patterns aren't read as files; `cautionOf` (routine commands block only on a clear yes); scoping (`scopeOf`: relevance, or `wide` for a search from `/`, a top-level folder or above home, via `wideRootOf`); the `CREDENTIAL`, `RELEVANCE` and `SYSTEM` question sets; and `judge`, which turns what was asked (`Asked`) into a `Decision`.
- `jev/hooks/routing.ts`: the `ROUTE` and `SPAWN` question sets, `routeOf` (work type to tier, with an Opus fallback), `spawnOf` (start or wait behind running agents), and Haiku briefs.
- `jev/hooks/band.ts`: turns a `View` into toned text segments for the band above the prompt.
- `jev/hooks/register.tsx`: wiring only (entry point listed in `hooks/hooks.json`). Each engine event goes through the boundary, then a pure function, then back to the engine. With no key, every hook passes its event on (`next(e)`) untouched.

Two invariants hold across these files:
- **Fail closed.** If Jev can't be reached, shell commands are blocked unless `cautionOf` finds them routine, and too-wide searches are blocked; file reads that pass the rules still go through. Routing falls back to Opus on `unsure`, `no-fit` or any `JevError`. The first turn always routes to Opus.
- **Nothing sent leaks content.** States sent to Jev contain prompts (the last three, clipped), task text and paths, patterns or commands. They never contain file contents.

## Data modeling: make invalid states unrepresentable

This is a hard requirement, and `npm run lint:adt` enforces part of it.

- **Use algebraic data types, never nulls.** Absence is `Option<T>`, failure is `Result<T, E>`, and every either/or is a discriminated union tagged by `kind`. Models never have nullable or optional fields. When a field exists only in some states, split the type into a variant per state (a permutated sum type) and put the field only on the variants where it is meaningful. Examples: `Ledger` holds counters only in its `active` variant; `View` keeps the red "key missing" indicator and the counters in separate variants; `Target`'s `Grep` variant has `glob: Option<string>` while its `Glob` variant has no such field.
- **Never read a noul as a boolean.** Read it into `Reading` (`yes`/`unsure`/`no`) and handle `unsure` as its own outcome.
- **Brand constrained scalars** (`Probability`, `Tokens`, `Count`, `Usd`, `ApiKey`, `AbsPath`), and create them only through their guards in `domain.ts`. Unchecked values become model types only in `boundary.ts`.
- **Make matches exhaustive**, ending in `absurd(x)`, so that adding a variant breaks the build everywhere it isn't handled.
- **Make capabilities into values.** The API key exists only inside `Active`, which proves it is present.
- **Outside `boundary.ts` and the tests**, the lint rejects `any`, `null`, `undefined`, casts (except `as const`), non-null `!`, `?.`, `??`, optional properties and optional parameters. Inside the boundary, only `any` is rejected. Don't work around the lint. If a new engine field is optional, decode it into an `Option` in the boundary.
- The tsconfig is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`). Keep it that way.

## Test-driven development

Write the failing test first, then the code that makes it pass, then refactor with the suite green. Finish with `npm run check`.

- `jev/tests/model.test.ts` tests the pure layer directly: decoding recorded Jev JSON, reading nouls, rules, `judge`, `routeOf` and `spawnOf`, and band text. Put new logic in the pure modules and test it here.
- `jev/tests/hooks.test.tsx` drives the registered hooks through the engine using `claude-code/testing`'s `mock`, `stage(on, env)` and `KEY`. Jev's answers, HTTP status, filesystem (`realOf`), live agents and session root are all staged in memory, and the stage records what was sent, run and spawned. Use it for wiring behavior: what gets blocked, which model is chosen, what the band shows, and silence when no key is set.
- Every bug fix starts with a test that reproduces the bug.
- When you add a type or variant, add tests that cover each variant, including the dormant (no key) and `JevError` paths.
