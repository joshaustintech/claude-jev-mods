# claude-jev-mods

A Claude Code mod that uses [Jev 1.14](https://openrouter.ai/typesafe/jev-1.14), TypeSafe's decision model on OpenRouter, to route work between Claude models and to guard what a session reads.

Jev does not generate text. It answers typed questions about a state with calibrated probabilities, in about a tenth of a second, so the mod can ask it on every prompt, subagent and guarded tool call.

## What it does

When `OPENROUTER_API_KEY` is set in the environment Claude Code starts from:

- **Routes models.** Each prompt is classified as planning or review (Opus), medium coding (Sonnet) or a clearly defined task (Haiku). The first turn always plans on Opus, and any answer Jev is not sure of falls back to Opus. Subagents are classified the same way.
- **Briefs subagents.** Haiku rewrites each subagent's task as a short brief (goal, scope, constraints, done when). The task as written is kept beneath it and wins where they differ.
- **Orders subagents.** The planner is told whether the parts of a request look independent. A subagent that arrives while others run starts only if Jev is clear that it is independent of them; otherwise it is refused until they report.
- **Blocks credential reads.** `.env` files, private keys, credential stores, environment dumps (`env`, `printenv`, `echo $SECRET`, `process.env`) and credential helpers (`gh auth token` and the like) are blocked by rules, with no model call. Every other `Read`, `Grep`, `Glob` and `Bash` call is put to Jev, and anything short of a clear no is blocked.
- **Blocks off-task source reads.** A read of source code inside the project is blocked when Jev is clear that it serves neither the task nor a step the task implies. Docs, manifests, config, searches and files outside the project are never blocked for relevance. `/jev allow <path-or-glob>` lifts the check for a path.

When the key is missing, the mod does none of this and says nothing in the transcript.

## What it shows

A band above the prompt:

```
● JEV · creds blocked 3 · irrelevant blocked 5 · Claude 182.4k tok $1.24 · JEV 61.0k tok $0.0026
```

or, with no key, in red:

```
● OPENROUTER_API_KEY missing: JEV routing and guards are off · Claude 182.4k tok $1.24
```

Counts are for the current session. Claude tokens are input, output and both sides of the prompt cache, summed over the main loop, subagents and the Haiku briefs; the Claude dollar figure is the session's own cost total. `/jev` prints the same line with the current route.

## Install

At the prompt of a terminal session:

```
/plugin install jev --marketplace joshaustintech/claude-jev-mods
```

From a shell:

```
claude plugin install jev --marketplace joshaustintech/claude-jev-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `joshaustintech/claude-jev-mods`, then Add plugin.

To run it from a checkout instead: `claude --plugin-dir ./jev`.

## What leaves your machine

For each decision the mod sends OpenRouter, and through it TypeSafe: your recent prompts (the last three, clipped), subagent task text, and the path, search pattern or shell command of the call being judged. It never sends file contents. Requests go to `https://openrouter.ai/api/alpha/decisions` and nowhere else.

## Limits

- The guards are best effort. Jev judges a read by its path or command, not by what the file holds, and a sufficiently obfuscated command can get past both the rules and the model.
- The credential guard fails closed: if Jev cannot be reached or refuses the key, shell commands are blocked until it answers. File reads that pass the rules still go through.
- The rules are strict. Any command that names a credential file is blocked, whatever it does with it, and `echo` of an upper-case variable other than a few harmless ones (`PATH`, `HOME`, ...) is blocked.
- Changing the main loop's model between turns drops its prompt cache at each change.

## How the code is built

`jev/types/index.d.ts` is the data model: tagged unions throughout, `Option` for absence and `Result` for failure. A noul is read as `yes`, `no` or `unsure`, never as a boolean. The API key exists only inside a value that proves it is there, and the counters exist only in the active variant of the session, so "guarding with no key" and "red indicator beside counters" have no value that spells them.

`jev/hooks/boundary.ts` is the only file that handles `undefined`, `null` or `unknown`: it decodes Jev's replies against the questions asked and turns the engine's optional fields into `Option`s. `npm run lint:adt` reads the syntax tree and fails on `any` anywhere, and outside the boundary on `null`, `undefined`, casts, `!`, `?.`, `??` and optional properties.

## Development

```
npm install
npm run lint:adt
claude plugin validate jev
claude plugin test jev
npm run typecheck
```

`npm run typecheck` needs the engine's type declarations, which Claude Code writes to `jev/.claude-plugin/types/` the first time it loads the mod from this folder (`claude --plugin-dir ./jev`).
