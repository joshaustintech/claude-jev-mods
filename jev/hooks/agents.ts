// The subagents this session started, kept only so that a subagent's file
// reads are judged against the task it was given. The mod does not decide
// whether, when or on what model a subagent runs: the engine does.

import type { Admitted, Option } from '../types'
import { absurd, none, some } from './domain'

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

/** The task a subagent was given, if this session saw it start. */
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
