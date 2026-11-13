// The jev mod's data model and its $.state contract.
//
// Every value the mod reasons about is one of these types. Absence is an
// Option, failure is a Result, and each either/or is a tagged union, so a
// state the mod should never be in has no value that spells it.

// ---------------------------------------------------------------- algebra

export type Option<T> =
  | { readonly kind: 'some'; readonly value: T }
  | { readonly kind: 'none' }

export type Result<T, E> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: E }

export type NonEmpty<T> = readonly [T, ...T[]]

// ---------------------------------------------------------------- scalars
// Branded: `__brand` exists only in the type, so each is made only by its
// guard in hooks/domain.ts.

/** A finite number from 0 to 1. */
export type Probability = number & { readonly __brand: 'Probability' }
/** A non-negative whole number of tokens. */
export type Tokens = number & { readonly __brand: 'Tokens' }
/** A non-negative whole number of events. */
export type Count = number & { readonly __brand: 'Count' }
/** A non-negative finite amount of US dollars. */
export type Usd = number & { readonly __brand: 'Usd' }
/** A non-empty OpenRouter API key. */
export type ApiKey = string & { readonly __brand: 'ApiKey' }
/** An absolute path, symbolic links resolved where the file exists. */
export type AbsPath = string & { readonly __brand: 'AbsPath' }

// ---------------------------------------------------------------- Jev

/** What a state may hold: JSON without null. */
export type Json =
  | string
  | number
  | boolean
  | readonly Json[]
  | { readonly [key: string]: Json }

export type Noul = {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria: { readonly true: string; readonly false: string }
}

export type Choice<O extends string> = {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<O, string>>
}

export type Question = Noul | Choice<string>
export type Questions = Readonly<Record<string, Question>>

export type NoulAnswer = { readonly type: 'noul'; readonly noul: Probability }

/** `probabilities` is total over the options, so `probabilities[choice]` exists. */
export type ChoiceAnswer<O extends string> = {
  readonly type: 'choice'
  readonly choice: O
  readonly probabilities: Readonly<Record<O, Probability>>
}

export type AnswerOf<Q> = Q extends Noul
  ? NoulAnswer
  : Q extends Choice<infer O>
    ? ChoiceAnswer<O>
    : never

/** One answer per question asked, each shaped by its question. */
export type AnswersOf<Qs extends Questions> = {
  readonly [K in keyof Qs]: AnswerOf<Qs[K]>
}

/** Where a noul stops being a no and starts being a yes. */
export type Band = {
  readonly noAtMost: Probability
  readonly yesAtLeast: Probability
}

/** A noul as code reads it: never a boolean, the middle its own outcome. */
export type Reading =
  | { readonly kind: 'yes'; readonly p: Probability }
  | { readonly kind: 'unsure'; readonly p: Probability }
  | { readonly kind: 'no'; readonly p: Probability }

export type JevError =
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'overloaded' }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'transport' }
  | { readonly kind: 'malformed'; readonly at: string }

export type Usage =
  | { readonly kind: 'reported'; readonly input: Tokens; readonly output: Tokens }
  | { readonly kind: 'estimated'; readonly input: Tokens }

export type Decided<Qs extends Questions> = {
  readonly answers: AnswersOf<Qs>
  readonly usage: Usage
}

// ---------------------------------------------------------------- shell

/**
 * One word of a command with its quotes taken off. `literal` is text the
 * shell leaves as written; `substituting` holds a `$(...)` or backticks, whose
 * commands are segments of their own; `expanding` holds a `$NAME`.
 */
export type Word = {
  readonly kind: 'literal' | 'substituting' | 'expanding'
  readonly text: string
}

/** A heredoc's body: `literal` when the shell would expand nothing in it. */
export type Heredoc = {
  readonly kind: 'literal' | 'expanding'
  readonly body: string
}

/** One simple command: what sits between `;`, `&&`, `||`, `|` and newlines. */
export type Segment = {
  readonly words: NonEmpty<Word>
  readonly heredoc: Option<Heredoc>
  /** The command its output is piped into, if it is. */
  readonly pipedInto: Option<string>
}

// ---------------------------------------------------------------- guard

export type Actor =
  | { readonly kind: 'main' }
  | { readonly kind: 'subagent'; readonly agentId: string }

export type Target =
  | { readonly kind: 'file'; readonly tool: string; readonly path: AbsPath; readonly asked: AbsPath }
  | {
      readonly kind: 'search'
      readonly tool: 'Grep'
      readonly root: AbsPath
      readonly pattern: string
      /** The file filter a content search carries, if any: which files it reads. */
      readonly glob: Option<string>
    }
  | {
      readonly kind: 'search'
      /** Lists names only, so it has no file filter to read through. */
      readonly tool: 'Glob'
      readonly root: AbsPath
      readonly pattern: string
    }
  | { readonly kind: 'command'; readonly tool: CommandTool; readonly command: string }

/** The tools that run a shell command. */
export type CommandTool = 'Bash' | 'Monitor'

export type Intent =
  | {
      readonly kind: 'read'
      readonly target: Target
      /** The other files of a call that names several; empty for most calls. */
      readonly more: readonly Target[]
      readonly actor: Actor
    }
  | { readonly kind: 'other' }

export type RuleId =
  | 'dotenv-file'
  | 'private-key-file'
  | 'credential-store-file'
  | 'secret-named-file'
  | 'environment-dump'
  | 'environment-variable-echo'
  | 'credential-helper'
  | 'credential-file-reader'

export type CredentialQuestionId =
  | 'reveals_env_values'
  | 'reads_secret_store'
  | 'prints_or_sends_token'

export type Evidence =
  | { readonly kind: 'rule'; readonly rule: RuleId }
  | { readonly kind: 'jev'; readonly question: CredentialQuestionId; readonly reading: Reading }
  | { readonly kind: 'unverified'; readonly error: JevError }

/** How much doubt blocks a call: `routine` commands only on a clear yes. */
export type Caution = 'strict' | 'routine'

export type Exemption =
  | 'not-source'
  | 'outside-root'
  | 'allow-listed'
  | 'search'
  | 'no-task'

/**
 * What a call is asked about besides credentials: relevance (`judge`),
 * nothing (`exempt`, and why), or, for a search that starts at `root` and is
 * too wide, whether the task needs the whole system.
 */
export type Scope =
  | { readonly kind: 'judge' }
  | { readonly kind: 'exempt'; readonly why: Exemption }
  | { readonly kind: 'wide'; readonly root: string }

export type Decision =
  | {
      readonly kind: 'allow'
      readonly basis:
        | { readonly kind: 'judged' }
        | { readonly kind: 'exempt'; readonly why: Exemption }
        | { readonly kind: 'system-task' }
        | { readonly kind: 'unjudged'; readonly error: JevError }
    }
  | {
      readonly kind: 'deny'
      readonly cause:
        | { readonly kind: 'credential'; readonly evidence: Evidence }
        | { readonly kind: 'irrelevant'; readonly p: Probability }
        | {
            readonly kind: 'wide-search'
            readonly root: string
            readonly why:
              | { readonly kind: 'jev'; readonly reading: Reading }
              | { readonly kind: 'unverified'; readonly error: JevError }
          }
    }

// ---------------------------------------------------------------- subagents

/** A subagent this session admitted: starting until the engine names it. */
export type Admitted = {
  readonly toolUseId: string
  readonly description: string
  readonly task: string
  readonly at: number
  readonly agent: Option<string>
}

// ---------------------------------------------------------------- session

export type Blocks = {
  readonly credential: Count
  readonly irrelevant: Count
  readonly wide: Count
}

export type JevSpend = {
  readonly tokens: Tokens
  readonly usd: Usd
  readonly precision: 'exact' | 'estimated'
}

/** What the guard knows of the work in hand. */
export type WorkContext = {
  readonly prompts: readonly string[]
  readonly read: readonly string[]
  readonly allowed: readonly string[]
  readonly admitted: readonly Admitted[]
}

/** What one Claude model used, as the API bills it: input split by cache side. */
export type ClaudeUsage = {
  readonly fresh: Tokens
  readonly cacheRead: Tokens
  readonly cacheWrite: Tokens
  readonly output: Tokens
}

/** US dollars per million tokens of each kind. */
export type Price = {
  readonly input: Usd
  readonly output: Usd
  readonly cacheRead: Usd
  readonly cacheWrite: Usd
}

/** One model's tally, under the id the API reported for it. */
export type ModelSpend = { readonly model: string; readonly usage: ClaudeUsage }

/**
 * The session as the mod keeps it. Counters, Jev's spend and the work context
 * exist only while a key is present: a dormant session has none to show.
 * Claude's use is kept per model, in the order the models were first used.
 */
export type Ledger =
  | { readonly kind: 'dormant'; readonly claude: readonly ModelSpend[] }
  | {
      readonly kind: 'active'
      readonly claude: readonly ModelSpend[]
      readonly blocks: Blocks
      readonly jev: JevSpend
      readonly work: WorkContext
    }

/** The key, held only by code that has checked it is there. */
export type Active = { readonly key: ApiKey }

export type Cost =
  | { readonly kind: 'known'; readonly usd: Usd }
  | { readonly kind: 'unknown' }

export type Spent = { readonly tokens: Tokens; readonly cost: Cost }

/** One model as the band draws it: input, then output, each with its spend. */
export type ModelLine = { readonly label: string; readonly input: Spent; readonly output: Spent }

/**
 * What the band draws: the red indicator and the counters never share a
 * variant. `claude` holds only models that have used tokens.
 */
export type View =
  | { readonly kind: 'dormant'; readonly claude: readonly ModelLine[] }
  | {
      readonly kind: 'active'
      readonly claude: readonly ModelLine[]
      readonly blocks: Blocks
      readonly jev: JevSpend
    }

declare module 'claude-code' {
  interface PluginState {
    jev: { ledger: Shaped<Ledger> }
  }
}
