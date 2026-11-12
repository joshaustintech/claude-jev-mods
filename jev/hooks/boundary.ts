// The boundary: the only file where `undefined`, `null`, `unknown` and a cast
// appear. Everything the engine or the network hands the mod is turned into
// the data model here, and nothing unchecked leaves this file.

import type { EngineInterface } from 'claude-code'

import type {
  AbsPath,
  Actor,
  AnswersOf,
  ApiKey,
  ChoiceAnswer,
  Cost,
  Decided,
  Intent,
  JevError,
  NonEmpty,
  NoulAnswer,
  Option,
  Probability,
  Question,
  Questions,
  Result,
  Tokens,
  Usage,
} from '../types'
import {
  claudeTokens,
  err,
  isAbsPath,
  isApiKey,
  isProbability,
  isUsd,
  none,
  normalize,
  ok,
  some,
  tokens,
} from './domain'

// ---------------------------------------------------------------- absence

/** What the engine leaves out or nulls becomes an Option at the door. */
export const optional = <T>(value: T | undefined | null): Option<T> =>
  value === undefined || value === null ? none : some(value)

export const lookup = <V>(
  record: Readonly<Record<string, V>>,
  key: string,
): Option<V> => (Object.hasOwn(record, key) ? optional(record[key]) : none)

export const nonEmpty = <T>(list: readonly T[]): Option<NonEmpty<T>> => {
  const [first, ...rest] = list

  return first === undefined ? none : some([first, ...rest])
}

// ---------------------------------------------------------------- decoding

type Unknowns = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Unknowns =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const field = (value: unknown, key: string): Option<unknown> =>
  isRecord(value) ? lookup(value, key) : none

const textField = (value: unknown, key: string): Option<string> => {
  const found = field(value, key)

  return found.kind === 'some' && typeof found.value === 'string'
    ? some(found.value)
    : none
}

const numberField = (value: unknown, key: string): Option<number> => {
  const found = field(value, key)

  return found.kind === 'some' && typeof found.value === 'number'
    ? some(found.value)
    : none
}

const probabilityField = (value: unknown, key: string): Option<Probability> => {
  const found = numberField(value, key)

  return found.kind === 'some' && isProbability(found.value)
    ? some(found.value)
    : none
}

const malformed = (at: string): Result<never, JevError> =>
  err({ kind: 'malformed', at })

type Answer = NoulAnswer | ChoiceAnswer<string>

const decodeAnswer = (
  id: string,
  question: Question,
  answer: unknown,
): Result<Answer, JevError> => {
  const type = textField(answer, 'type')

  if (type.kind === 'none' || type.value !== question.type) {
    return malformed(`answers.${id}.type`)
  }

  if (question.type === 'noul') {
    const noul = probabilityField(answer, 'noul')

    return noul.kind === 'some'
      ? ok({ type: 'noul', noul: noul.value })
      : malformed(`answers.${id}.noul`)
  }

  const options = Object.keys(question.criteria)
  const choice = textField(answer, 'choice')

  if (choice.kind === 'none' || !options.includes(choice.value)) {
    return malformed(`answers.${id}.choice`)
  }

  const given = field(answer, 'probabilities')
  const probabilities: Record<string, Probability> = {}

  for (const option of options) {
    const p =
      given.kind === 'some' ? probabilityField(given.value, option) : none

    if (p.kind === 'none') {
      return malformed(`answers.${id}.probabilities.${option}`)
    }

    probabilities[option] = p.value
  }

  return ok({ type: 'choice', choice: choice.value, probabilities })
}

const decodeUsage = (body: unknown, sentChars: number): Usage => {
  const usage = field(body, 'usage')
  const given = usage.kind === 'some' ? usage.value : {}
  const typesafeInput = numberField(given, 'input_tokens')
  const input =
    typesafeInput.kind === 'some'
      ? typesafeInput
      : numberField(given, 'prompt_tokens')
  const typesafeOutput = numberField(given, 'output_tokens')
  const output =
    typesafeOutput.kind === 'some'
      ? typesafeOutput
      : numberField(given, 'completion_tokens')

  return input.kind === 'some'
    ? {
        kind: 'reported',
        input: tokens(input.value),
        output: tokens(output.kind === 'some' ? output.value : 0),
      }
    : // No usage in the reply: about four characters to a token.
      { kind: 'estimated', input: tokens(Math.ceil(sentChars / 4)) }
}

/**
 * A reply as the questions typed it, or `malformed` naming the first field
 * that is not what was asked for: never a partly filled answer.
 */
export const decodeDecided = <Qs extends Questions>(
  questions: Qs,
  body: unknown,
  sentChars: number,
): Result<Decided<Qs>, JevError> => {
  const answers = field(body, 'answers')

  if (answers.kind === 'none') {
    return malformed('answers')
  }

  const decoded: Record<string, Answer> = {}

  for (const [id, question] of Object.entries(questions)) {
    const answer = field(answers.value, id)

    if (answer.kind === 'none') {
      return malformed(`answers.${id}`)
    }

    const one = decodeAnswer(id, question, answer.value)

    if (one.kind === 'err') {
      return one
    }

    decoded[id] = one.value
  }

  // The one cast in the mod: every id of `questions` was just checked to hold
  // an answer of its question's type, which is what AnswersOf<Qs> says.
  return ok({
    answers: decoded as AnswersOf<Qs>,
    usage: decodeUsage(body, sentChars),
  })
}

// ---------------------------------------------------------------- network

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

const errorOf = (status: number): JevError => {
  if (status === 401 || status === 403) {
    return { kind: 'unauthorized' }
  }

  if (status === 429) {
    return { kind: 'rate-limited' }
  }

  if (status === 529 || status === 503) {
    return { kind: 'overloaded' }
  }

  return { kind: 'rejected', status }
}

const parse = (text: string): Result<unknown, JevError> => {
  try {
    const parsed: unknown = JSON.parse(text)

    return ok(parsed)
  } catch {
    return malformed('body')
  }
}

/** One POST to the Decisions API: the parsed body, or why there is none. */
export async function post(
  $: EngineInterface,
  key: ApiKey,
  body: string,
): Promise<Result<unknown, JevError>> {
  const sent = await $.http
    .fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    .then(
      response => ok(response),
      (): Result<never, JevError> => err({ kind: 'transport' }),
    )

  if (sent.kind === 'err') {
    return sent
  }

  return sent.value.ok ? parse(sent.value.text) : err(errorOf(sent.value.status))
}

// ---------------------------------------------------------------- engine

/** The key, if the environment holds one. The name is the mod's one env read. */
export async function readKey($: EngineInterface): Promise<Option<ApiKey>> {
  const value = await $.env.get('OPENROUTER_API_KEY').then(optional, () => none)

  return value.kind === 'some' && isApiKey(value.value)
    ? some(value.value)
    : none
}

export async function sessionCost($: EngineInterface): Promise<Cost> {
  return $.session.usage().then(
    (usage): Cost => {
      const cost = optional(usage.cost)

      return cost.kind === 'some' && isUsd(cost.value.usd)
        ? { kind: 'known', usd: cost.value.usd }
        : { kind: 'unknown' }
    },
    (): Cost => ({ kind: 'unknown' }),
  )
}

/** A turn's usage as tokens; a turn that reports none used none we can count. */
export const turnTokens = (
  usage:
    | {
        readonly input_tokens: number
        readonly output_tokens: number
        readonly cache_read_input_tokens: number
        readonly cache_creation_input_tokens: number
      }
    | undefined,
): Tokens => (usage === undefined ? tokens(0) : claudeTokens(usage))

export type Completion = { readonly text: string; readonly used: Tokens }

/** One Haiku completion; none when it did not answer or could not be sent. */
export async function completeWithHaiku(
  $: EngineInterface,
  system: string,
  prompt: string,
): Promise<Option<Completion>> {
  return $.model.complete({ model: 'haiku', system, prompt }).then(
    (reply): Option<Completion> =>
      reply.isAnswered && reply.text.trim().length > 0
        ? some({ text: reply.text, used: claudeTokens(reply.usage) })
        : none,
    (): Option<Completion> => none,
  )
}

/** The ids of the subagents that are starting, running or waiting now. */
export async function liveAgentIds(
  $: EngineInterface,
): Promise<readonly string[]> {
  return $.agent.list().then(
    agents =>
      agents
        .filter(
          agent =>
            agent.status === 'pending' ||
            agent.status === 'running' ||
            agent.status === 'waiting',
        )
        .map(agent => agent.id),
    (): readonly string[] => [],
  )
}

/** The id the engine gave a subagent it started; none for a refused spawn. */
export const spawnedAgent = (started: {
  readonly deny?: string | undefined
  readonly agentId?: string | undefined
}): Option<string> =>
  started.deny === undefined ? optional(started.agentId) : none

async function resolve(
  $: EngineInterface,
  cwd: string,
  raw: string,
): Promise<Option<{ readonly asked: AbsPath; readonly real: AbsPath }>> {
  const asked = normalize(raw.startsWith('/') ? raw : `${cwd}/${raw}`)
  // A file that is not there has no link to resolve: its own spelling stands.
  const real = await $.fs.stat(asked, { resolve: true }).then(
    stat => {
      const resolved = optional(stat.realPath)

      return resolved.kind === 'some' ? resolved.value : asked
    },
    () => asked,
  )

  return isAbsPath(asked) && isAbsPath(real) ? some({ asked, real }) : none
}

const MCP_FILE_READER = /^mcp__.*(read|file|cat|open)/i

/** The tools the guard looks at; every other call passes untouched. */
export const isGuardedTool = (tool: string): boolean =>
  tool === 'Bash' ||
  tool === 'Read' ||
  tool === 'NotebookRead' ||
  tool === 'Grep' ||
  tool === 'Glob' ||
  MCP_FILE_READER.test(tool)

/**
 * What a tool call is to the guard: a read of a file, a search, a shell
 * command, or none of its business. `input` is the event as the engine gave
 * it, read field by field.
 */
export async function classify(
  $: EngineInterface,
  cwd: string,
  tool: string,
  input: unknown,
  actor: Actor,
): Promise<Intent> {
  if (tool === 'Bash') {
    const command = textField(input, 'command')

    return command.kind === 'some'
      ? { kind: 'read', actor, target: { kind: 'command', command: command.value } }
      : { kind: 'other' }
  }

  if (tool === 'Grep' || tool === 'Glob') {
    const pattern = textField(input, 'pattern')
    const path = textField(input, 'path')
    const root = await resolve($, cwd, path.kind === 'some' ? path.value : cwd)

    return pattern.kind === 'some' && root.kind === 'some'
      ? {
          kind: 'read',
          actor,
          target: { kind: 'search', tool, root: root.value.real, pattern: pattern.value },
        }
      : { kind: 'other' }
  }

  if (tool === 'Read' || tool === 'NotebookRead' || MCP_FILE_READER.test(tool)) {
    const filePath = textField(input, 'file_path')
    const notebookPath = textField(input, 'notebook_path')
    const plainPath = textField(input, 'path')
    const named =
      filePath.kind === 'some'
        ? filePath
        : notebookPath.kind === 'some'
          ? notebookPath
          : plainPath

    if (named.kind === 'none') {
      return { kind: 'other' }
    }

    const path = await resolve($, cwd, named.value)

    return path.kind === 'some'
      ? {
          kind: 'read',
          actor,
          target: { kind: 'file', tool, path: path.value.real, asked: path.value.asked },
        }
      : { kind: 'other' }
  }

  return { kind: 'other' }
}
