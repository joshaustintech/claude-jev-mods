// Routing, all of it pure: the questions Jev is asked about a piece of work,
// and how its answers become a model tier, a brief and a go or a wait.

import type {
  Admitted,
  AnswersOf,
  Band,
  Brief,
  JevError,
  Json,
  NonEmpty,
  Option,
  Probability,
  Reading,
  Result,
  Route,
  Spawn,
  Tier,
  Work,
} from '../types'
import { absurd, clip, none, readNoul, some } from './domain'
import { choice, noul } from './decisions'

// ---------------------------------------------------------------- questions

const WORK = choice<Work>('What kind of work does `request` ask for?', {
  plan_or_review:
    'Planning, architecture or design decisions, open-ended investigation, debugging with an unknown cause, or reviewing code or a plan',
  medium_coding:
    'Implementing or changing code of moderate difficulty where what to build is already clear',
  defined_task:
    'A small, clearly specified task with an obvious procedure: a rename, a lookup, a formatting change, running a named command, a mechanical edit',
})

// A Choice always picks something, so its companion says whether any option fits.
const FITS = noul(
  'Is `request` a software task that clearly fits one of: planning or review, implementing code, or a small mechanical task?',
  'The request is plainly one of those three kinds of work',
  'The request is something else, mixes several kinds, or is too vague to tell',
)

export const ROUTE = {
  work: WORK,
  fits_a_work_kind: FITS,
  subtasks_are_independent: noul(
    'If `request` were split into subtasks, could those subtasks be done at the same time without depending on one another?',
    'The parts touch separate files or questions and none needs another part finished first',
    'The parts build on each other, touch the same files, or there is only one part',
  ),
} as const

export const SPAWN = {
  work: WORK,
  fits_a_work_kind: FITS,
  independent_of_running: noul(
    'Can `request` be carried out at the same time as every task in `running` without conflict?',
    'It needs no result from the running tasks and would not edit the files they are working on',
    'It depends on what a running task will produce, or could touch the same files',
  ),
} as const

// ---------------------------------------------------------------- routes

export const tierOf = (work: Work): Tier => {
  switch (work) {
    case 'plan_or_review':
      return 'opus'
    case 'medium_coding':
      return 'sonnet'
    case 'defined_task':
      return 'haiku'
    default:
      return absurd(work)
  }
}

const fallback = (
  cause: Extract<Route['why'], { kind: 'fallback' }>['cause'],
): Route => ({ tier: 'opus', why: { kind: 'fallback', cause } })

type Routed = Pick<AnswersOf<typeof ROUTE>, 'work' | 'fits_a_work_kind'>

/**
 * A route acts on Jev's pick only when some option clearly fits and the
 * picked option is likely enough; anything less plans on Opus.
 */
export const routeOf = (
  band: Band,
  atLeast: Probability,
  outcome: Result<Routed, JevError>,
): Route => {
  if (outcome.kind === 'err') {
    return fallback(outcome.error.kind)
  }

  const { work, fits_a_work_kind: fits } = outcome.value

  if (readNoul(band, fits.noul).kind !== 'yes') {
    return fallback('no-fit')
  }

  const p = work.probabilities[work.choice]

  return p >= atLeast
    ? { tier: tierOf(work.choice), why: { kind: 'jev', work: work.choice, p } }
    : fallback('unsure')
}

export const routeState = (request: string, earlier: readonly string[]): Json => ({
  request: clip(request, 6000),
  earlier_requests: earlier,
})

/** What the planner is told, unseen by the user, about running subagents. */
export const concurrencyNote = (independent: Reading): string => {
  switch (independent.kind) {
    case 'yes':
      return 'JEV routing: the parts of this request look independent. If you delegate to subagents, launch them in parallel, in a single message.'
    case 'no':
      return 'JEV routing: the parts of this request look dependent on one another. If you delegate to subagents, run them one at a time, each after the previous one has reported.'
    case 'unsure':
      return 'JEV routing: it is unclear whether the parts of this request are independent. Run subagents one at a time unless they plainly touch separate files.'
    default:
      return absurd(independent)
  }
}

// ---------------------------------------------------------------- spawns

/** How long a spawn may stay unnamed by the engine before it is forgotten. */
const STARTING_FOR_MS = 60_000

/** The admitted subagents still in flight: starting, or named and alive. */
export const inFlight = (
  admitted: readonly Admitted[],
  live: readonly string[],
  now: number,
): readonly Admitted[] =>
  admitted.filter(one => {
    switch (one.agent.kind) {
      case 'none':
        return now - one.at < STARTING_FOR_MS
      case 'some':
        return live.includes(one.agent.value)
      default:
        return absurd(one.agent)
    }
  })

/** The task a subagent was given, if this session admitted it. */
export const taskOf = (
  admitted: readonly Admitted[],
  agentId: string,
): Option<string> =>
  admitted.reduce<Option<string>>(
    (found, one) =>
      one.agent.kind === 'some' && one.agent.value === agentId
        ? some(one.task)
        : found,
    none,
  )

export const spawnState = (
  description: string,
  agentType: string,
  task: string,
  running: readonly Admitted[],
): Json => ({
  request: { description, agent_type: agentType, task: clip(task, 6000) },
  running: running.map(one => ({
    description: one.description,
    task: clip(one.task, 1500),
  })),
})

/**
 * Whether a subagent starts now, and on what. With others in flight it
 * starts only on a clear yes that it is independent of them: an unsure
 * answer or a failed request waits, which is the safe order.
 */
export const spawnOf = (
  band: Band,
  atLeast: Probability,
  running: Option<NonEmpty<string>>,
  outcome: Result<AnswersOf<typeof SPAWN>, JevError>,
): Spawn => {
  const route = routeOf(band, atLeast, outcome)

  if (running.kind === 'some') {
    const isIndependent =
      outcome.kind === 'ok' &&
      readNoul(band, outcome.value.independent_of_running.noul).kind === 'yes'

    if (!isIndependent) {
      return { kind: 'wait', behind: running.value }
    }
  }

  return { kind: 'start', tier: route.tier, route }
}

export const waitText = (behind: NonEmpty<string>): string =>
  `jev: not started yet. Jev judged this task dependent on work still running (${behind.join('; ')}). Start it again once that has reported.`

// ---------------------------------------------------------------- briefs

export const BRIEF_SYSTEM = [
  'You write briefs for coding subagents. You are given a task another model wrote for a subagent.',
  'Rewrite it as a brief with these headings, in this order: Goal, Scope, Constraints, Done when.',
  'Use only what the task says. Add no requirement, file name or fact that is not in it. Do not answer the task.',
  'Reply with the brief alone, in under 250 words.',
].join(' ')

export const briefRequest = (description: string, agentType: string, task: string): string =>
  `Subagent type: ${agentType}\nShort description: ${description}\n\nTask:\n${task}`

export const briefOf = (written: Option<string>, original: string): Brief => {
  switch (written.kind) {
    case 'some':
      return { kind: 'meta', text: written.value.trim(), original }
    case 'none':
      return { kind: 'original', text: original }
    default:
      return absurd(written)
  }
}

/** The prompt a subagent runs with: the brief first, the task as written after it. */
export const briefText = (brief: Brief): string => {
  switch (brief.kind) {
    case 'meta':
      return `${brief.text}\n\n---\nThe task as originally written, which wins wherever the brief above differs from it:\n\n${brief.original}`
    case 'original':
      return brief.text
    default:
      return absurd(brief)
  }
}

export const describeRoute = (route: Route): string => {
  switch (route.why.kind) {
    case 'first-turn':
      return `${route.tier} (first turn plans on Opus)`
    case 'jev':
      return `${route.tier} (Jev: ${route.why.work} at ${route.why.p.toFixed(2)})`
    case 'fallback':
      return `${route.tier} (fallback: ${route.why.cause})`
    default:
      return absurd(route.why)
  }
}
