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

// ---------------------------------------------------------------- guard

export type Actor =
  | { readonly kind: 'main' }
  | { readonly kind: 'subagent'; readonly agentId: string }

export type Target =
  | { readonly kind: 'file'; readonly tool: string; readonly path: AbsPath; readonly asked: AbsPath }
  | { readonly kind: 'search'; readonly tool: string; readonly root: AbsPath; readonly pattern: string }
  | { readonly kind: 'command'; readonly command: string }

export type Intent =
  | { readonly kind: 'read'; readonly target: Target; readonly actor: Actor }
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

export type Exemption =
  | 'not-source'
  | 'outside-root'
  | 'allow-listed'
  | 'search'
  | 'no-task'

/** Whether a read is held to the relevance questions, and if not, why not. */
export type Scope =
  | { readonly kind: 'judge' }
  | { readonly kind: 'exempt'; readonly why: Exemption }

export type Decision =
  | {
      readonly kind: 'allow'
      readonly basis:
        | { readonly kind: 'judged' }
        | { readonly kind: 'exempt'; readonly why: Exemption }
        | { readonly kind: 'unjudged'; readonly error: JevError }
    }
  | {
      readonly kind: 'deny'
      readonly cause:
        | { readonly kind: 'credential'; readonly evidence: Evidence }
        | { readonly kind: 'irrelevant'; readonly p: Probability }
    }

// ---------------------------------------------------------------- routing

export type Tier = 'opus' | 'sonnet' | 'haiku'
export type Work = 'plan_or_review' | 'medium_coding' | 'defined_task'

export type Route = {
  readonly tier: Tier
  readonly why:
    | { readonly kind: 'first-turn' }
    | { readonly kind: 'jev'; readonly work: Work; readonly p: Probability }
    | { readonly kind: 'fallback'; readonly cause: 'no-fit' | 'unsure' | JevError['kind'] }
}

export type Brief =
  | { readonly kind: 'meta'; readonly text: string; readonly original: string }
  | { readonly kind: 'original'; readonly text: string }

/** A subagent this session admitted: starting until the engine names it. */
export type Admitted = {
  readonly toolUseId: string
  readonly description: string
  readonly task: string
  readonly at: number
  readonly agent: Option<string>
}

export type Spawn =
  | { readonly kind: 'start'; readonly tier: Tier; readonly route: Route }
  | { readonly kind: 'wait'; readonly behind: NonEmpty<string> }

// ---------------------------------------------------------------- session

export type Blocks = { readonly credential: Count; readonly irrelevant: Count }

export type JevSpend = {
  readonly tokens: Tokens
  readonly usd: Usd
  readonly precision: 'exact' | 'estimated'
}

/** What the guard and the router know of the work in hand. */
export type WorkContext = {
  readonly prompts: readonly string[]
  readonly route: Route
  readonly read: readonly string[]
  readonly allowed: readonly string[]
  readonly admitted: readonly Admitted[]
}

/**
 * The session as the mod keeps it. Counters, Jev's spend and the work context
 * exist only while a key is present: a dormant session has none to show.
 */
export type Ledger =
  | { readonly kind: 'dormant'; readonly claude: Tokens }
  | {
      readonly kind: 'active'
      readonly claude: Tokens
      readonly blocks: Blocks
      readonly jev: JevSpend
      readonly work: WorkContext
    }

/** The key, held only by code that has checked it is there. */
export type Active = { readonly key: ApiKey }

export type Cost =
  | { readonly kind: 'known'; readonly usd: Usd }
  | { readonly kind: 'unknown' }

/** What the band draws: the red indicator and the counters never share a variant. */
export type View =
  | { readonly kind: 'dormant'; readonly claude: Tokens; readonly cost: Cost }
  | {
      readonly kind: 'active'
      readonly claude: Tokens
      readonly cost: Cost
      readonly blocks: Blocks
      readonly jev: JevSpend
    }

declare module 'claude-code' {
  interface PluginState {
    jev: { ledger: Shaped<Ledger> }
  }
}
