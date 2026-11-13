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
  ClaudeUsage,
  CommandTool,
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
  Target,
  Usage,
} from '../types'
import {
  err,
  isAbsPath,
  isApiKey,
  isProbability,
  none,
  normalize,
  ok,
  some,
  tokens,
  usageOf,
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

/** The strings of a list field; none when it is absent or holds none. */
const textsField = (value: unknown, key: string): readonly string[] => {
  const found = field(value, key)

  return found.kind === 'some' && Array.isArray(found.value)
    ? found.value.filter((one): one is string => typeof one === 'string')
    : []
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

/** The key, if the environment holds one: one of the mod's two env reads. */
export async function readKey($: EngineInterface): Promise<Option<ApiKey>> {
  const value = await $.env.get('OPENROUTER_API_KEY').then(optional, () => none)

  return value.kind === 'some' && isApiKey(value.value)
    ? some(value.value)
    : none
}

/**
 * A turn's usage and the model that answered it; none when the turn reports
 * none (an interrupt, an API error), so it is filed under no model.
 */
export const turnUsage = (
  usage:
    | {
        readonly model: string
        readonly input_tokens: number
        readonly output_tokens: number
        readonly cache_read_input_tokens: number
        readonly cache_creation_input_tokens: number
      }
    | undefined,
): Option<{ readonly model: string; readonly used: ClaudeUsage }> =>
  usage === undefined ? none : some({ model: usage.model, used: usageOf(usage) })

export type Completion = { readonly text: string; readonly used: ClaudeUsage }

/** One Haiku completion; none when it did not answer or could not be sent. */
export async function completeWithHaiku(
  $: EngineInterface,
  system: string,
  prompt: string,
): Promise<Option<Completion>> {
  return $.model.complete({ model: 'haiku', system, prompt }).then(
    (reply): Option<Completion> =>
      reply.isAnswered && reply.text.trim().length > 0
        ? some({ text: reply.text, used: usageOf(reply.usage) })
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

const isAbsolute = (raw: string): boolean => /^([A-Za-z]:)?[\\/]/.test(raw)

/**
 * A path as the rules read it: `/` between its parts whatever the platform
 * wrote, `.` and `..` worked out, and a leading `/` (so `C:\repo\.env` is
 * `/C:/repo/.env`). Only compared and matched, never handed back to a tool.
 */
const canonical = (path: string): string => normalize(path.replace(/\\/g, '/'))

/** Where a path lands with its links followed; its own spelling when it leads nowhere. */
async function landing($: EngineInterface, path: string): Promise<string> {
  return $.fs.stat(path, { resolve: true }).then(
    stat => {
      const resolved = optional(stat.realPath)

      return canonical(resolved.kind === 'some' ? resolved.value : path)
    },
    () => canonical(path),
  )
}

async function resolve(
  $: EngineInterface,
  cwd: string,
  raw: string,
): Promise<Option<{ readonly asked: AbsPath; readonly real: AbsPath }>> {
  const full = isAbsolute(raw) ? raw : `${cwd}/${raw}`
  const asked = canonical(full)
  // A file that is not there has no link to resolve: its own spelling stands.
  const real = await landing($, full)

  return isAbsPath(asked) && isAbsPath(real) ? some({ asked, real }) : none
}

/**
 * The session's root resolved the way a read's path is, so a root reached
 * through a link still holds the files under it.
 */
export async function sessionRoot($: EngineInterface): Promise<string> {
  return landing($, await $.session.root())
}

/**
 * The user's home folder, resolved the way a search's root is. The mod's
 * other env read: it says how wide a search is, and is never sent anywhere.
 */
export async function homeDir($: EngineInterface): Promise<Option<AbsPath>> {
  const posix = await $.env.get('HOME').then(optional, () => none)
  const given =
    posix.kind === 'some'
      ? posix
      : await $.env.get('USERPROFILE').then(optional, () => none)

  if (given.kind === 'none' || !isAbsolute(given.value)) {
    return none
  }

  const real = await landing($, given.value)

  return isAbsPath(real) ? some(real) : none
}

const MCP_FILE_READER =
  /^mcp__.*(read|file|cat|open|get|view|load|show|fetch|text|content|head|tail)/i

const isCommandTool = (tool: string): tool is CommandTool =>
  tool === 'Bash' || tool === 'Monitor'

/** The tools the guard looks at; every other call passes untouched. */
export const isGuardedTool = (tool: string): boolean =>
  isCommandTool(tool) ||
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
  if (isCommandTool(tool)) {
    const command = textField(input, 'command')

    return command.kind === 'some'
      ? {
          kind: 'read',
          actor,
          target: { kind: 'command', tool, command: command.value },
          more: [],
        }
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
          // Glob's pattern only lists names; Grep's `glob` picks what is read.
          target:
            tool === 'Grep'
              ? {
                  kind: 'search',
                  tool,
                  root: root.value.real,
                  pattern: pattern.value,
                  glob: textField(input, 'glob'),
                }
              : { kind: 'search', tool, root: root.value.real, pattern: pattern.value },
          more: [],
        }
      : { kind: 'other' }
  }

  if (tool === 'Read' || tool === 'NotebookRead' || MCP_FILE_READER.test(tool)) {
    // One file under any of the usual names, or several in a list.
    const named = [
      ...['file_path', 'notebook_path', 'path', 'file', 'filename'].flatMap(key => {
        const one = textField(input, key)

        return one.kind === 'some' ? [one.value] : []
      }),
      ...['paths', 'file_paths', 'files'].flatMap(key => textsField(input, key)),
    ]
    const resolved = await Promise.all(named.map(raw => resolve($, cwd, raw)))
    const targets = resolved.flatMap((path): readonly Target[] =>
      path.kind === 'some'
        ? [{ kind: 'file', tool, path: path.value.real, asked: path.value.asked }]
        : [],
    )
    const [target, ...more] = targets

    return target === undefined
      ? { kind: 'other' }
      : { kind: 'read', actor, target, more }
  }

  return { kind: 'other' }
}
