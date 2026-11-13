# claude-jev-mods

A Claude Code mod that uses [Jev 1.14](https://openrouter.ai/typesafe/jev-1.14), TypeSafe's decision model on OpenRouter, to route work between Claude models and to guard what a session reads.

Jev does not generate text. It answers typed questions about a state with calibrated probabilities, in about a tenth of a second, so the mod can ask it on every prompt, subagent and guarded tool call.

## What it does

When `OPENROUTER_API_KEY` is set in the environment Claude Code starts from:

- **Routes models.** Each prompt is classified as planning or review (Opus), medium coding (Sonnet) or a clearly defined task (Haiku). The first turn always plans on Opus, and any answer Jev is not sure of falls back to Opus. Subagents are classified the same way.
- **Briefs subagents.** Haiku rewrites each subagent's task as a short brief (goal, scope, constraints, done when). The task as written is kept beneath it and wins where they differ.
- **Orders subagents.** The planner is told whether the parts of a request look independent. A subagent that arrives while others run starts only if Jev is clear that it is independent of them; otherwise it is refused until they report.
- **Blocks credential reads.** `.env` files, private keys, credential stores, environment dumps (`env`, `printenv`, `echo $SECRET`, `process.env`) and credential helpers (`gh auth token` and the like) are blocked by rules, with no model call. Every other `Read`, `Grep`, `Glob` and `Bash` call is put to Jev, and anything short of a clear no is blocked. Routine commands (everyday `git` and `gh pr`, `npm`/`pnpm`/`yarn`/`bun` scripts, `ls`, `tsc` and the like, with nothing secret expanded into them) are blocked only on a clear yes.
- **Blocks off-task source reads.** A read of source code inside the project is blocked when Jev is clear that it serves neither the task nor a step the task implies. Docs, manifests, config, searches and files outside the project are never blocked for relevance. `/jev allow <path-or-glob>` lifts the check for a path.
- **Blocks too-wide searches.** A search that starts at `/`, at a top-level folder (`/usr`, `/etc`, ...) or at a folder above your home (`/Users`) is blocked unless Jev puts the task's need for a system-wide search at 0.6 or more. This covers `Grep`, `Glob`, and `find`, `grep -r`, `rg`, `fd`, `ls -R`, `du`, `tree`, `locate` and `mdfind` in shell commands. Searches inside the project or your home folder, and deeper system paths such as `/usr/local/lib/node_modules`, aren't affected.

When the key is missing, the mod does none of this and says nothing in the transcript.

## What it shows

A band above the prompt, one row for the guard, one per Claude model, and one for Jev:

```
● JEV  blocked  creds 3 · off-task 5 · wide 1
Fable 5.2   in  1.24M $0.41   out 38.0k $1.52
Sonnet 5.5  in 210.0k $0.05   out  9.1k $0.09
JEV         61.0k tok $0.0026
```

or, with no key, in red:

```
● OPENROUTER_API_KEY missing · JEV routing and guards are off
Fable 5.2   in 1.24M $0.41   out 38.0k $1.52
```

The band uses your theme's colors: labels are dim, a block count turns to the warning color once it is above zero, and the missing-key line is in the error color. Model columns line up so the figures can be compared at a glance, and a row wraps rather than running past the band's edge.

Counts are for the current session. Each Claude model gets its own row: input tokens, input spend, output tokens, output spend. Rows appear in the order the models were first used, and a model that has used no tokens isn't shown. Input counts uncached tokens and both sides of the prompt cache, each priced at its own rate. The figures cover the main loop, subagents and the Haiku briefs. Jev appears once, as a single total. `/jev` prints the same rows with the current route.

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
- The credential guard fails closed: if Jev cannot be reached or refuses the key, shell commands are blocked until it answers, except routine ones. File reads that pass the rules still go through. Too-wide searches are blocked while Jev can't answer.
- The rules are strict. Any command that names a credential file is blocked, whatever it does with it, and `echo` of an upper-case variable other than a few harmless ones (`PATH`, `HOME`, ...) is blocked. Commands are read the way the shell reads them, so the rules don't read text a command only carries: a commit, tag or PR message (`-m`, `-am`, `--body`, `--title`, or a heredoc given to `git commit -F -` or `cat`), a search pattern (`grep`, `rg`, `git log --grep`), or an `echo` of a variable the same command set. A message that runs or expands something, such as `$(cat .env)`, is still checked, and so is a heredoc fed to a shell or interpreter.
- Claude spend uses Anthropic's first-party list prices, built into the mod. A turn is filed under the model that answered its last response, and a Haiku brief under Haiku 5.5. Cache writes are priced at the 5-minute rate. Fast mode, Haiku 5.5's pricing above 100K tokens, and models the mod doesn't know (shown as `cost n/a`) aren't priced.
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
