// The Jev client: typed questions about a state in, typed answers out.

import type { EngineInterface } from 'claude-code'

import type {
  Active,
  Choice,
  Decided,
  JevError,
  Json,
  Noul,
  Questions,
  Result,
} from '../types'
import { decodeDecided, post } from './boundary'
import { isRetryable } from './domain'

/** Jev 1.14 as OpenRouter names it. */
export const MODEL = 'typesafe/jev-1.14'

const RETRY_AFTER_MS = 250

/** A yes/no question. Phrase it so that a high value means yes. */
export const noul = (instructions: string, yes: string, no: string): Noul => ({
  type: 'noul',
  instructions,
  criteria: { true: yes, false: no },
})

/** A pick from the options named by `criteria`'s keys. */
export const choice = <O extends string>(
  instructions: string,
  criteria: Readonly<Record<O, string>>,
): Choice<O> => ({ type: 'choice', instructions, criteria })

/**
 * Asks every question about one state in one request. Taking an `Active` is
 * what keeps this from being called without a key. A rate limit or an
 * overload is tried once more.
 */
export async function decide<Qs extends Questions>(
  $: EngineInterface,
  active: Active,
  state: Json,
  questions: Qs,
): Promise<Result<Decided<Qs>, JevError>> {
  const body = JSON.stringify({ model: MODEL, state, questions })
  const first = await post($, active.key, body)
  const reply =
    first.kind === 'err' && isRetryable(first.error)
      ? await $.clock
          .sleep(RETRY_AFTER_MS)
          .then(() => post($, active.key, body))
      : first

  return reply.kind === 'ok'
    ? decodeDecided(questions, reply.value, body.length)
    : reply
}
