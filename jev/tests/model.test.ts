// The data model on its own: decoding, reading nouls, rules, judging, routing.
// The JSON here is as TypeSafe's docs record Jev's replies.

import { expect, test } from 'claude-code/testing'

import type { Probability, WorkContext } from '../types'
import { segmentsOf, textOf } from '../hooks/band'
import { decodeDecided } from '../hooks/boundary'
import {
  DEFAULT_BAND,
  FIRST_ROUTE,
  INITIAL,
  ROUTE_AT_LEAST,
  applyDecision,
  bandOf,
  err,
  none,
  ok,
  probability,
  readNoul,
  some,
  spendOf,
  viewOf,
  wake,
} from '../hooks/domain'
import { CREDENTIAL, RELEVANCE, commandRule, judge, pathRule, scopeOf } from '../hooks/guard'
import { ROUTE, SPAWN, routeOf, spawnOf } from '../hooks/routing'

const p = (n: number): Probability => {
  const made = probability(n)

  if (made.kind === 'none') {
    throw new Error(`${n} is not a probability`)
  }

  return made.value
}

const noul = (n: number) => ({ type: 'noul', noul: n })

const WORK: WorkContext = {
  prompts: ['Fix the login redirect bug'],
  route: FIRST_ROUTE,
  read: [],
  allowed: [],
  admitted: [],
}

test('a recorded noul reply decodes, with its usage', () => {
  const decided = decodeDecided(
    CREDENTIAL,
    {
      model: 'jev-1.14.0',
      answers: {
        reveals_env_values: noul(0.99),
        reads_secret_store: noul(0.93),
        prints_or_sends_token: noul(0.02),
      },
      usage: { input_tokens: 360, output_tokens: 39 },
    },
    1000,
  )

  expect(decided.kind).toBe('ok')

  if (decided.kind === 'ok') {
    expect(decided.value.answers.reveals_env_values.noul).toBe(0.99)
    expect(decided.value.usage).toEqual({ kind: 'reported', input: 360, output: 39 })
    expect(spendOf(decided.value.usage).tokens).toBe(399)
  }
})

test('a recorded choice reply decodes with a probability for every option', () => {
  const decided = decodeDecided(
    ROUTE,
    {
      answers: {
        work: {
          type: 'choice',
          choice: 'medium_coding',
          confidence: 0.42,
          probabilities: { plan_or_review: 0.04, medium_coding: 0.61, defined_task: 0.35 },
        },
        fits_a_work_kind: noul(0.98),
        subtasks_are_independent: noul(0.44),
      },
    },
    800,
  )

  expect(decided.kind).toBe('ok')

  if (decided.kind === 'ok') {
    const { work } = decided.value.answers
    expect(work.probabilities[work.choice]).toBe(0.61)
    // No usage in the reply: estimated from what was sent.
    expect(decided.value.usage).toEqual({ kind: 'estimated', input: 200 })
  }
})

test('a reply that is not what was asked is malformed, never partly filled', () => {
  const full = {
    reveals_env_values: noul(0.1),
    reads_secret_store: noul(0.1),
    prints_or_sends_token: noul(0.1),
  }
  const at = (answers: unknown) => {
    const decided = decodeDecided(CREDENTIAL, { answers }, 10)

    return decided.kind === 'err' && decided.error.kind === 'malformed'
      ? decided.error.at
      : 'decoded'
  }

  expect(at({ ...full, reads_secret_store: noul(1.4) })).toBe('answers.reads_secret_store.noul')
  expect(at({ ...full, reads_secret_store: { type: 'choice', choice: 'x' } })).toBe(
    'answers.reads_secret_store.type',
  )
  expect(at({ reveals_env_values: noul(0.1) })).toBe('answers.reads_secret_store')
  expect(decodeDecided(CREDENTIAL, 'nonsense', 10).kind).toBe('err')

  const stray = decodeDecided(
    { work: ROUTE.work },
    { answers: { work: { type: 'choice', choice: 'other', probabilities: {} } } },
    10,
  )
  expect(stray).toEqual(err({ kind: 'malformed', at: 'answers.work.choice' }))

  const partial = decodeDecided(
    { work: ROUTE.work },
    {
      answers: {
        work: { type: 'choice', choice: 'defined_task', probabilities: { defined_task: 1 } },
      },
    },
    10,
  )
  expect(partial).toEqual(
    err({ kind: 'malformed', at: 'answers.work.probabilities.plan_or_review' }),
  )
})

test('a noul reads as yes, no, or unsure: the middle is its own outcome', () => {
  expect(readNoul(DEFAULT_BAND, p(0.02)).kind).toBe('no')
  expect(readNoul(DEFAULT_BAND, p(0.3)).kind).toBe('no')
  expect(readNoul(DEFAULT_BAND, p(0.44)).kind).toBe('unsure')
  expect(readNoul(DEFAULT_BAND, p(0.7)).kind).toBe('yes')
  expect(readNoul(DEFAULT_BAND, p(0.98)).kind).toBe('yes')
  // A band cannot be made upside down.
  expect(bandOf(p(0.9), p(0.1))).toEqual({ noAtMost: 0.1, yesAtLeast: 0.9 })
  expect(probability(1.2)).toEqual(none)
  expect(probability(Number.NaN)).toEqual(none)
})

test('the rules catch credential files and commands without a model', () => {
  expect(pathRule('/repo/.env')).toEqual(some('dotenv-file'))
  expect(pathRule('/repo/.env.production')).toEqual(some('dotenv-file'))
  expect(pathRule('/repo/.env.example')).toEqual(none)
  expect(pathRule('/Users/x/.ssh/id_ed25519')).toEqual(some('private-key-file'))
  expect(pathRule('/Users/x/.ssh/id_ed25519.pub')).toEqual(none)
  expect(pathRule('/Users/x/.aws/credentials')).toEqual(some('credential-store-file'))
  expect(pathRule('/repo/config/secrets.yaml')).toEqual(some('secret-named-file'))
  expect(pathRule('/repo/src/token.ts')).toEqual(none)
  expect(pathRule('/repo/src/login.ts')).toEqual(none)

  expect(commandRule('printenv')).toEqual(some('environment-dump'))
  expect(commandRule('cd app && env | sort')).toEqual(some('environment-dump'))
  expect(commandRule('node -e "console.log(process.env)"')).toEqual(some('environment-dump'))
  expect(commandRule('echo $OPENROUTER_API_KEY')).toEqual(some('environment-variable-echo'))
  expect(commandRule('gh auth token')).toEqual(some('credential-helper'))
  expect(commandRule('cat ./.env | head')).toEqual(some('credential-file-reader'))
  expect(commandRule('env NODE_ENV=test npm test')).toEqual(none)
  expect(commandRule('echo "$PATH"')).toEqual(none)
  expect(commandRule('git status && npm run build')).toEqual(none)
})

test('only source code inside the root is held to relevance', () => {
  const file = (path: string) =>
    scopeOf({ kind: 'file', tool: 'Read', path: path as never, asked: path as never }, '/repo', WORK)

  expect(file('/repo/src/billing/invoice.ts')).toEqual({ kind: 'judge' })
  expect(file('/repo/README.md')).toEqual({ kind: 'exempt', why: 'not-source' })
  expect(file('/elsewhere/lib/x.ts')).toEqual({ kind: 'exempt', why: 'outside-root' })
  expect(
    scopeOf({ kind: 'command', command: 'cat src/billing/invoice.ts' }, '/repo', WORK),
  ).toEqual({ kind: 'judge' })
  expect(scopeOf({ kind: 'command', command: 'npm test' }, '/repo', WORK)).toEqual({
    kind: 'exempt',
    why: 'not-source',
  })
  expect(
    scopeOf(
      { kind: 'file', tool: 'Read', path: '/repo/src/billing/invoice.ts' as never, asked: '/repo/src/billing/invoice.ts' as never },
      '/repo',
      { ...WORK, allowed: ['src/billing'] },
    ),
  ).toEqual({ kind: 'exempt', why: 'allow-listed' })
  expect(
    scopeOf(
      { kind: 'file', tool: 'Read', path: '/repo/a.ts' as never, asked: '/repo/a.ts' as never },
      '/repo',
      { ...WORK, prompts: [] },
    ),
  ).toEqual({ kind: 'exempt', why: 'no-task' })
})

const credential = (a: number, b: number, c: number) => ({
  reveals_env_values: { type: 'noul' as const, noul: p(a) },
  reads_secret_store: { type: 'noul' as const, noul: p(b) },
  prints_or_sends_token: { type: 'noul' as const, noul: p(c) },
})

const relevance = (a: number, b: number) =>
  some({
    needed_for_task: { type: 'noul' as const, noul: p(a) },
    needed_for_implied_subtask: { type: 'noul' as const, noul: p(b) },
  })

test('the guard denies on a credential yes or unsure, and on two clear relevance nos', () => {
  const file = { kind: 'file', tool: 'Read', path: '/repo/src/a.ts' as never, asked: '/repo/src/a.ts' as never } as const
  const command = { kind: 'command', command: 'make deploy' } as const
  const judging = { kind: 'judge' } as const
  const kindOf = (decision: ReturnType<typeof judge>) =>
    decision.kind === 'deny' ? decision.cause.kind : decision.basis.kind

  // Unsure is not a clear no: missing a true yes is the costly error.
  expect(
    kindOf(judge(DEFAULT_BAND, file, judging, ok({ credential: credential(0.05, 0.44, 0.02), relevance: relevance(0.9, 0.9) }))),
  ).toBe('credential')
  expect(
    kindOf(judge(DEFAULT_BAND, file, judging, ok({ credential: credential(0.05, 0.1, 0.02), relevance: relevance(0.08, 0.12) }))),
  ).toBe('irrelevant')
  // One clear no is not enough to block source code.
  expect(
    kindOf(judge(DEFAULT_BAND, file, judging, ok({ credential: credential(0.05, 0.1, 0.02), relevance: relevance(0.08, 0.5) }))),
  ).toBe('judged')
  expect(
    kindOf(judge(DEFAULT_BAND, file, { kind: 'exempt', why: 'not-source' }, ok({ credential: credential(0, 0, 0), relevance: none }))),
  ).toBe('exempt')
  // Jev unreachable: a file that passed the rules is read, a command is not run.
  expect(kindOf(judge(DEFAULT_BAND, file, judging, err({ kind: 'transport' })))).toBe('unjudged')
  expect(kindOf(judge(DEFAULT_BAND, command, judging, err({ kind: 'transport' })))).toBe('credential')
  expect(Object.keys({ ...CREDENTIAL, ...RELEVANCE }).length).toBe(5)
})

const routed = (choice: 'plan_or_review' | 'medium_coding' | 'defined_task', top: number, fits: number) => {
  const rest = p((1 - top) / 2)

  return {
    work: {
      type: 'choice' as const,
      choice,
      probabilities: { plan_or_review: rest, medium_coding: rest, defined_task: rest, [choice]: p(top) },
    },
    fits_a_work_kind: { type: 'noul' as const, noul: p(fits) },
  }
}

test('a route acts on a likely pick that fits, and plans on Opus otherwise', () => {
  const route = (...args: Parameters<typeof routed>) =>
    routeOf(DEFAULT_BAND, ROUTE_AT_LEAST, ok(routed(...args)))

  expect(route('plan_or_review', 0.9, 0.95).tier).toBe('opus')
  expect(route('medium_coding', 0.9, 0.95).tier).toBe('sonnet')
  expect(route('defined_task', 0.9, 0.95).tier).toBe('haiku')
  expect(route('defined_task', 0.6, 0.95)).toEqual({ tier: 'opus', why: { kind: 'fallback', cause: 'unsure' } })
  // The companion noul: a confident pick means nothing when no option fits.
  expect(route('defined_task', 0.96, 0.02)).toEqual({ tier: 'opus', why: { kind: 'fallback', cause: 'no-fit' } })
  expect(routeOf(DEFAULT_BAND, ROUTE_AT_LEAST, err({ kind: 'overloaded' }))).toEqual({
    tier: 'opus',
    why: { kind: 'fallback', cause: 'overloaded' },
  })
})

test('a subagent starts beside others only on a clear yes that it is independent', () => {
  const answers = (independent: number) =>
    ok({ ...routed('medium_coding', 0.9, 0.95), independent_of_running: { type: 'noul' as const, noul: p(independent) } })
  const busy = some(['Refactor auth'] as const)

  expect(spawnOf(DEFAULT_BAND, ROUTE_AT_LEAST, none, answers(0.05)).kind).toBe('start')
  expect(spawnOf(DEFAULT_BAND, ROUTE_AT_LEAST, busy, answers(0.9))).toMatchObject({ kind: 'start', tier: 'sonnet' })
  expect(spawnOf(DEFAULT_BAND, ROUTE_AT_LEAST, busy, answers(0.5))).toEqual({ kind: 'wait', behind: ['Refactor auth'] })
  expect(spawnOf(DEFAULT_BAND, ROUTE_AT_LEAST, busy, err({ kind: 'transport' })).kind).toBe('wait')
  expect(Object.keys(SPAWN)).toContain('independent_of_running')
})

test('a deny is counted because it is a deny, and only while active', () => {
  const deny = { kind: 'deny', cause: { kind: 'irrelevant', p: p(0.1) } } as const
  const counted = applyDecision(applyDecision(wake(INITIAL), deny), deny)

  expect(counted.kind === 'active' && counted.blocks.irrelevant).toBe(2)
  expect(applyDecision(INITIAL, deny)).toEqual(INITIAL)
})

test('the band shows the red indicator only when dormant, the counters only when active', () => {
  const dormant = viewOf(INITIAL, { kind: 'unknown' })
  const active = viewOf(wake(INITIAL), { kind: 'unknown' })

  expect(segmentsOf(dormant).map(segment => segment.tone)).toContain('alarm')
  expect(textOf(dormant)).toContain('OPENROUTER_API_KEY missing')
  expect(textOf(dormant)).not.toContain('blocked')
  expect(segmentsOf(active).map(segment => segment.tone)).not.toContain('alarm')
  expect(textOf(active)).toContain('creds blocked 0 · irrelevant blocked 0')
})
