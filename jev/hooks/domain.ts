// Constructors and pure functions over the data model in ../types.
// Nothing here can fail: a value out of range is clamped or refused as an
// Option, and every match over a union is exhaustive.

import type {
  AbsPath,
  ApiKey,
  Band,
  Blocks,
  ClaudeUsage,
  Count,
  Decision,
  JevError,
  JevSpend,
  Ledger,
  ModelLine,
  ModelSpend,
  Option,
  Price,
  Probability,
  Reading,
  Result,
  Route,
  Tier,
  Tokens,
  Usage,
  Usd,
  View,
  WorkContext,
} from '../types'

// ---------------------------------------------------------------- algebra

export const some = <T>(value: T): Option<T> => ({ kind: 'some', value })
export const none: Option<never> = { kind: 'none' }
export const ok = <T>(value: T): Result<T, never> => ({ kind: 'ok', value })
export const err = <E>(error: E): Result<never, E> => ({ kind: 'err', error })

/** The end of an exhaustive match: reaching it is a compile error. */
export const absurd = (value: never): never => {
  throw new Error(`jev: unreachable variant ${String(value)}`)
}

const outOfRange = (what: string): never => {
  throw new Error(`jev: ${what} left its range`)
}

export const mapResult = <T, U, E>(
  result: Result<T, E>,
  change: (value: T) => U,
): Result<U, E> => (result.kind === 'ok' ? ok(change(result.value)) : result)

// ---------------------------------------------------------------- scalars

export const isProbability = (n: number): n is Probability =>
  Number.isFinite(n) && n >= 0 && n <= 1

export const isTokens = (n: number): n is Tokens =>
  Number.isSafeInteger(n) && n >= 0

export const isCount = (n: number): n is Count =>
  Number.isSafeInteger(n) && n >= 0

export const isUsd = (n: number): n is Usd => Number.isFinite(n) && n >= 0

export const isApiKey = (text: string): text is ApiKey => text.trim().length > 0

export const isAbsPath = (text: string): text is AbsPath => text.startsWith('/')

const wholeNonNegative = (n: number): number =>
  Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)
    : 0

/** The nearest token count: negatives and non-numbers are zero. */
export const tokens = (n: number): Tokens => {
  const whole = wholeNonNegative(n)

  return isTokens(whole) ? whole : outOfRange('tokens')
}

export const count = (n: number): Count => {
  const whole = wholeNonNegative(n)

  return isCount(whole) ? whole : outOfRange('count')
}

export const usd = (n: number): Usd => {
  const amount = Number.isFinite(n) && n > 0 ? n : 0

  return isUsd(amount) ? amount : outOfRange('usd')
}

export const probability = (n: number): Option<Probability> =>
  isProbability(n) ? some(n) : none

/** For constants written in this file: the nearest probability. */
const nearestProbability = (n: number): Probability => {
  const clamped = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0

  return isProbability(clamped) ? clamped : outOfRange('probability')
}

export const addTokens = (a: Tokens, b: Tokens): Tokens => tokens(a + b)
export const addUsd = (a: Usd, b: Usd): Usd => usd(a + b)
const increment = (n: Count): Count => count(n + 1)

// ---------------------------------------------------------------- nouls

/** Ordered by construction: a band whose no sits above its yes cannot be made. */
export const bandOf = (a: Probability, b: Probability): Band =>
  a <= b ? { noAtMost: a, yesAtLeast: b } : { noAtMost: b, yesAtLeast: a }

/** The docs' starting points: at most 0.3 is a no, at least 0.7 a yes. */
export const DEFAULT_BAND: Band = bandOf(
  nearestProbability(0.3),
  nearestProbability(0.7),
)

/** A too-wide search runs when the task's need for it is at least 0.6. */
export const SYSTEM_BAND: Band = bandOf(
  nearestProbability(0.3),
  nearestProbability(0.6),
)

/** How likely the chosen option must be before a route acts on it. */
export const ROUTE_AT_LEAST: Probability = nearestProbability(0.7)

export const readNoul = (band: Band, p: Probability): Reading => {
  if (p >= band.yesAtLeast) {
    return { kind: 'yes', p }
  }

  if (p <= band.noAtMost) {
    return { kind: 'no', p }
  }

  return { kind: 'unsure', p }
}

export const isRetryable = (error: JevError): boolean => {
  switch (error.kind) {
    case 'rate-limited':
    case 'overloaded':
      return true
    case 'unauthorized':
    case 'rejected':
    case 'transport':
    case 'malformed':
      return false
    default:
      return absurd(error)
  }
}

// ---------------------------------------------------------------- spend

/** Jev 1.14 on OpenRouter: $0.042 per million input tokens, output free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

export const spendOf = (usage: Usage): JevSpend => {
  switch (usage.kind) {
    case 'reported':
      return {
        tokens: addTokens(usage.input, usage.output),
        usd: usd(usage.input * USD_PER_INPUT_TOKEN),
        precision: 'exact',
      }
    case 'estimated':
      return {
        tokens: usage.input,
        usd: usd(usage.input * USD_PER_INPUT_TOKEN),
        precision: 'estimated',
      }
    default:
      return absurd(usage)
  }
}

const addSpend = (a: JevSpend, b: JevSpend): JevSpend => ({
  tokens: addTokens(a.tokens, b.tokens),
  usd: addUsd(a.usd, b.usd),
  precision:
    a.precision === 'exact' && b.precision === 'exact' ? 'exact' : 'estimated',
})

/** What one Claude response used: fresh input, both cache sides, and output. */
export const usageOf = (usage: {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}): ClaudeUsage => ({
  fresh: tokens(usage.input_tokens),
  cacheRead: tokens(usage.cache_read_input_tokens),
  cacheWrite: tokens(usage.cache_creation_input_tokens),
  output: tokens(usage.output_tokens),
})

const addUsage = (a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage => ({
  fresh: addTokens(a.fresh, b.fresh),
  cacheRead: addTokens(a.cacheRead, b.cacheRead),
  cacheWrite: addTokens(a.cacheWrite, b.cacheWrite),
  output: addTokens(a.output, b.output),
})

/**
 * The model each tier alias stands for. Only a Haiku brief needs it: a
 * completion reports no model id, so its use is filed under this one.
 */
export const TIER_MODEL: Readonly<Record<Tier, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

type Family = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku'
type PriceRow = { readonly families: readonly Family[]; readonly version: string; readonly price: Price }

const priced = (input: number, output: number, cacheRead: number, cacheWrite: number): Price => ({
  input: usd(input),
  output: usd(output),
  cacheRead: usd(cacheRead),
  cacheWrite: usd(cacheWrite),
})

/**
 * Anthropic's first-party rates per million tokens. A cache write is priced
 * at the 5-minute rate: a turn's usage does not say which TTL it wrote.
 */
const PRICES: readonly PriceRow[] = [
  { families: ['fable', 'mythos'], version: '5.2', price: priced(8, 40, 0.2, 10) },
  { families: ['fable', 'mythos'], version: '5.1', price: priced(10, 50, 0.25, 12.5) },
  { families: ['fable', 'mythos'], version: '5', price: priced(10, 50, 1, 12.5) },
  { families: ['opus'], version: '5.5', price: priced(4, 20, 0.2, 5) },
  ...['5', '4.8', '4.7', '4.6'].map(
    (version): PriceRow => ({ families: ['opus'], version, price: priced(5, 25, 0.5, 6.25) }),
  ),
  { families: ['sonnet'], version: '5.5', price: priced(2, 10, 0.1, 2.5) },
  { families: ['sonnet'], version: '5', price: priced(2, 10, 0.2, 2.5) },
  { families: ['sonnet'], version: '4.6', price: priced(3, 15, 0.3, 3.75) },
  { families: ['haiku'], version: '5.5', price: priced(0.1, 0.5, 0.01, 0.125) },
  { families: ['haiku'], version: '4.5', price: priced(1, 5, 0.1, 1.25) },
]

/** Family and version inside any spelling: `anthropic.` prefixes, `[1m]`, dated snapshots. */
const MODEL_ID = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/g

const firstOf = <T>(list: readonly T[]): Option<T> =>
  list.reduce<Option<T>>((found, one) => (found.kind === 'some' ? found : some(one)), none)

/** A model's name and rates, or none for an id the table does not know. */
export const priceOf = (id: string): Option<{ readonly label: string; readonly price: Price }> =>
  firstOf(
    [...id.toLowerCase().matchAll(MODEL_ID)].flatMap(([, family = '', major = '', minor = '']) => {
      const version = minor === '' ? major : `${major}.${minor}`

      return PRICES.filter(
        row => row.version === version && row.families.some(one => one === family),
      ).map(row => ({
        label: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`,
        price: row.price,
      }))
    }),
  )

const PER_MILLION = 1_000_000

/** One model's tally as the band draws it: input across both cache sides, then output. */
export const lineOf = (spend: ModelSpend): ModelLine => {
  const { usage } = spend
  const known = priceOf(spend.model)
  const input = addTokens(addTokens(usage.fresh, usage.cacheRead), usage.cacheWrite)

  if (known.kind === 'none') {
    return {
      label: spend.model,
      input: { tokens: input, cost: { kind: 'unknown' } },
      output: { tokens: usage.output, cost: { kind: 'unknown' } },
    }
  }

  const { price } = known.value

  return {
    label: known.value.label,
    input: {
      tokens: input,
      cost: {
        kind: 'known',
        usd: usd(
          (usage.fresh * price.input +
            usage.cacheRead * price.cacheRead +
            usage.cacheWrite * price.cacheWrite) /
            PER_MILLION,
        ),
      },
    },
    output: {
      tokens: usage.output,
      cost: { kind: 'known', usd: usd((usage.output * price.output) / PER_MILLION) },
    },
  }
}

// ---------------------------------------------------------------- ledger

export const FIRST_ROUTE: Route = { tier: 'opus', why: { kind: 'first-turn' } }

const NO_BLOCKS: Blocks = {
  credential: count(0),
  irrelevant: count(0),
  wide: count(0),
}
const NO_SPEND: JevSpend = { tokens: tokens(0), usd: usd(0), precision: 'exact' }
const NO_WORK: WorkContext = {
  prompts: [],
  route: FIRST_ROUTE,
  read: [],
  allowed: [],
  admitted: [],
}

export const INITIAL: Ledger = { kind: 'dormant', claude: [] }

export type ActiveLedger = Extract<Ledger, { kind: 'active' }>

/** A key is present: counters and spend begin, or carry on. */
export const wake = (ledger: Ledger): ActiveLedger => {
  switch (ledger.kind) {
    case 'active':
      return ledger
    case 'dormant':
      return {
        kind: 'active',
        claude: ledger.claude,
        blocks: NO_BLOCKS,
        jev: NO_SPEND,
        work: NO_WORK,
      }
    default:
      return absurd(ledger)
  }
}

/** No key: nothing of Jev's is kept. */
export const sleep = (ledger: Ledger): Ledger => ({
  kind: 'dormant',
  claude: ledger.claude,
})

/** A model's use added to its own tally, or a new tally after the others. */
export const addClaude = (ledger: Ledger, model: string, used: ClaudeUsage): Ledger => ({
  ...ledger,
  claude: ledger.claude.some(spend => spend.model === model)
    ? ledger.claude.map(spend =>
        spend.model === model ? { model, usage: addUsage(spend.usage, used) } : spend,
      )
    : [...ledger.claude, { model, usage: used }],
})

export const addJev = (ledger: Ledger, spend: JevSpend): Ledger => {
  switch (ledger.kind) {
    case 'dormant':
      return ledger
    case 'active':
      return { ...ledger, jev: addSpend(ledger.jev, spend) }
    default:
      return absurd(ledger)
  }
}

export const withWork = (
  ledger: Ledger,
  change: (work: WorkContext) => WorkContext,
): Ledger => {
  switch (ledger.kind) {
    case 'dormant':
      return ledger
    case 'active':
      return { ...ledger, work: change(ledger.work) }
    default:
      return absurd(ledger)
  }
}

const countBlock = (blocks: Blocks, decision: Decision): Blocks => {
  switch (decision.kind) {
    case 'allow':
      return blocks
    case 'deny':
      switch (decision.cause.kind) {
        case 'credential':
          return { ...blocks, credential: increment(blocks.credential) }
        case 'irrelevant':
          return { ...blocks, irrelevant: increment(blocks.irrelevant) }
        case 'wide-search':
          return { ...blocks, wide: increment(blocks.wide) }
        default:
          return absurd(decision.cause)
      }
    default:
      return absurd(decision)
  }
}

/**
 * The one place a counter moves: a deny is counted because it is a deny, and
 * nothing else can move a counter.
 */
export const applyDecision = (ledger: Ledger, decision: Decision): Ledger => {
  switch (ledger.kind) {
    case 'dormant':
      return ledger
    case 'active':
      return { ...ledger, blocks: countBlock(ledger.blocks, decision) }
    default:
      return absurd(ledger)
  }
}

/** The models that have used tokens, as the band draws them. */
const linesOf = (claude: readonly ModelSpend[]): readonly ModelLine[] =>
  claude.map(lineOf).filter(line => line.input.tokens + line.output.tokens > 0)

export const viewOf = (ledger: Ledger): View => {
  switch (ledger.kind) {
    case 'dormant':
      return { kind: 'dormant', claude: linesOf(ledger.claude) }
    case 'active':
      return {
        kind: 'active',
        claude: linesOf(ledger.claude),
        blocks: ledger.blocks,
        jev: ledger.jev,
      }
    default:
      return absurd(ledger)
  }
}

// ---------------------------------------------------------------- paths

/** A path with its `.` and `..` segments worked out, links untouched. */
export const normalize = (path: string): string => {
  const kept = path.split('/').reduce<readonly string[]>((parts, part) => {
    if (part === '' || part === '.') {
      return parts
    }

    return part === '..' ? parts.slice(0, -1) : [...parts, part]
  }, [])

  return `/${kept.join('/')}`
}

export const isUnder = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

/** The last `limit` of a list with one more on the end, repeats dropped. */
export const remember = (
  list: readonly string[],
  item: string,
  limit: number,
): readonly string[] =>
  [...list.filter(one => one !== item), item].slice(-limit)

export const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text
