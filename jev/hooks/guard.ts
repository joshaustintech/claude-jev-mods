// The guard's judgment, all of it pure: rules that need no model, the
// questions Jev is asked, and how its answers become a Decision.

import type {
  AnswersOf,
  Band,
  CredentialQuestionId,
  Decision,
  Evidence,
  JevError,
  Json,
  Noul,
  Option,
  Reading,
  Result,
  RuleId,
  Scope,
  Target,
  WorkContext,
} from '../types'
import { absurd, clip, isUnder, none, readNoul, some } from './domain'
import { noul } from './decisions'

// ---------------------------------------------------------------- rules
// "Use code when you can": what a pattern settles never reaches the model.

const TEMPLATE_ENV = /\.(example|sample|template|dist)$/i
const DOTENV = /(^|\/)\.env(rc|\.[^/]*)?$/i
const PRIVATE_KEY =
  /(\.(pem|key|p12|pfx|jks|keystore|ppk)$)|((^|\/)id_(rsa|dsa|ecdsa|ed25519)$)|(\/\.gnupg\/)/i
const SSH_PRIVATE = /\/\.ssh\/(?!known_hosts$|config$|authorized_keys$)(?![^/]*\.pub$)[^/]+$/i
const CREDENTIAL_STORE =
  /(\/\.aws\/credentials$)|((^|\/)\.(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials|terraformrc)$)|(\/\.my\.cnf$)|(\/\.docker\/config\.json$)|(\/\.kube\/config$)|((^|\/)kubeconfig$)|(application_default_credentials\.json$)|(\/gh\/hosts\.yml$)|(\/Keychains\/)|(\.tfvars$)|(\.tfstate$)|((^|\/)service[-_]?account[^/]*\.json$)|(^\/proc\/[^/]+\/environ$)/i
const SECRET_NAME =
  /(^|\/)[^/]*(secret|credential|passw(or)?d|token|api[-_]?key)[^/]*$/i
const DATA_FILE = /(\.(json|ya?ml|toml|txt|ini|cfg|conf|properties|xml|csv)$)|((^|\/)[^/.]+$)/i

/** The rule a path breaks, if any. */
export const pathRule = (path: string): Option<RuleId> => {
  if (DOTENV.test(path) && !TEMPLATE_ENV.test(path)) {
    return some('dotenv-file')
  }

  if (PRIVATE_KEY.test(path) || SSH_PRIVATE.test(path)) {
    return some('private-key-file')
  }

  if (CREDENTIAL_STORE.test(path)) {
    return some('credential-store-file')
  }

  if (SECRET_NAME.test(path) && DATA_FILE.test(path)) {
    return some('secret-named-file')
  }

  return none
}

const ENV_DUMP_WORD = /^(printenv|export\s+-p|declare\s+-[xp]|typeset\s+-x)(\s|$)/
const ENV_ALONE = /^(env|set)(\s+-[A-Za-z0]+)*$/
const ENV_IN_CODE = /process\.env|os\.environ|os\.getenv|System\.getenv|ENV\[|\bgetenv\(/
const HARMLESS_VARIABLE =
  /^(PATH|HOME|PWD|OLDPWD|USER|LOGNAME|SHELL|TERM|LANG|LC_ALL|TMPDIR|HOSTNAME|EDITOR|PAGER)$/
const ECHOED_VARIABLE = /\$\{?([A-Z][A-Z0-9_]*)/g
const ECHO = /^(echo|printf)(\s|$)/
const CREDENTIAL_HELPER =
  /\bsecurity\s+(find|dump)-[a-z-]*(password|keychain)|\bgh\s+auth\s+(token|status\s+.*(-t|--show-token))|\baws\s+configure\s+(get|list|export-credentials)|\bgcloud\s+auth\s+(application-default\s+)?print-(access|identity)-token|\bop\s+(read|item\s+get)\b|\bpass\s+show\b|\bvault\s+(kv\s+get|read)\b|\bgit\s+credential\s+fill|\bkubectl\s+(get\s+secrets?|config\s+view\s+.*--raw)|\bnpm\s+token\b|\bheroku\s+auth:token/

const segmentsOf = (command: string): readonly string[] =>
  command
    .split(/&&|\|\||[;|\n]|\$\(|`/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)

const wordsOf = (command: string): readonly string[] =>
  command
    .split(/[\s=<>|;&()`]+/)
    .map(word => word.replace(/^['"@]+|['"]+$/g, ''))
    .filter(word => word.length > 0)

const echoesVariable = (segment: string): boolean =>
  ECHO.test(segment) &&
  [...segment.matchAll(ECHOED_VARIABLE)].some(
    ([, name = '']) => !HARMLESS_VARIABLE.test(name),
  )

/** The rule a shell command breaks, if any. */
export const commandRule = (command: string): Option<RuleId> => {
  const segments = segmentsOf(command)

  if (
    segments.some(s => ENV_DUMP_WORD.test(s) || ENV_ALONE.test(s)) ||
    ENV_IN_CODE.test(command)
  ) {
    return some('environment-dump')
  }

  if (segments.some(echoesVariable)) {
    return some('environment-variable-echo')
  }

  if (CREDENTIAL_HELPER.test(command)) {
    return some('credential-helper')
  }

  // Any word that names a credential file, whatever the command does with it.
  return wordsOf(command).some(word => pathRule(word).kind === 'some')
    ? some('credential-file-reader')
    : none
}

export const ruleFor = (target: Target): Option<RuleId> => {
  switch (target.kind) {
    case 'file': {
      const real = pathRule(target.path)

      // A link is judged by where it points and by what it is called.
      return real.kind === 'some' ? real : pathRule(target.asked)
    }
    case 'search': {
      const root = pathRule(target.root)

      return root.kind === 'some' ? root : pathRule(target.pattern)
    }
    case 'command':
      return commandRule(target.command)
    default:
      return absurd(target)
  }
}

// ---------------------------------------------------------------- scope

const SOURCE_FILE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|php|scala|sh|bash|zsh|pl|lua|r|m|mm|dart|ex|exs|erl|hs|clj|cljs|elm|vue|svelte|sql|zig|nim|ml|fs)$/i
const FILE_READER = /^(cat|head|tail|less|more|bat|nl|sed|awk|xxd|strings|od)(\s|$)/

const globToPattern = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('**')
      .map(part =>
        part
          .split('*')
          .map(literal => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  )

/** Whether `/jev allow` covers a path: the entry, a folder above it, or a glob. */
export const isAllowed = (allowed: readonly string[], path: string): boolean =>
  allowed.some(
    entry =>
      path === entry ||
      path.endsWith(`/${entry}`) ||
      isUnder(entry, path) ||
      path.includes(`/${entry.replace(/\/$/, '')}/`) ||
      (entry.includes('*') &&
        (globToPattern(entry).test(path) ||
          globToPattern(`**/${entry}`).test(path))),
  )

/**
 * Whether a read is held to the relevance questions. Only source code inside
 * the session's root is: docs, manifests, config, searches and anything
 * outside the root are how a task is found, and are never blocked for it.
 */
export const scopeOf = (
  target: Target,
  root: string,
  work: WorkContext,
): Scope => {
  if (work.prompts.length === 0) {
    return { kind: 'exempt', why: 'no-task' }
  }

  switch (target.kind) {
    case 'search':
      return { kind: 'exempt', why: 'search' }
    case 'file':
      if (!isUnder(root, target.path)) {
        return { kind: 'exempt', why: 'outside-root' }
      }

      if (isAllowed(work.allowed, target.path)) {
        return { kind: 'exempt', why: 'allow-listed' }
      }

      return SOURCE_FILE.test(target.path)
        ? { kind: 'judge' }
        : { kind: 'exempt', why: 'not-source' }
    case 'command': {
      const sources = segmentsOf(target.command)
        .filter(segment => FILE_READER.test(segment))
        .flatMap(wordsOf)
        .filter(word => SOURCE_FILE.test(word))

      if (sources.length === 0) {
        return { kind: 'exempt', why: 'not-source' }
      }

      return sources.every(word => isAllowed(work.allowed, word))
        ? { kind: 'exempt', why: 'allow-listed' }
        : { kind: 'judge' }
    }
    default:
      return absurd(target)
  }
}

// ---------------------------------------------------------------- questions
// Atomic: one condition each, all asked of one state in one request.

export const CREDENTIAL: Readonly<Record<CredentialQuestionId, Noul>> = {
  reveals_env_values: noul(
    'Would carrying out `call` read, print or export the value of an environment variable?',
    'The call outputs or reads environment variable values, for one variable or for all of them',
    'The call does not touch environment variable values; merely setting a variable for a command it runs does not count',
  ),
  reads_secret_store: noul(
    'Does `call` read a file or store whose purpose is to hold credentials?',
    'The target holds API keys, tokens, passwords, private keys, certificates with keys, or cloud or registry login state',
    'The target is ordinary source code, documentation, data or configuration that is not meant to hold secrets',
  ),
  prints_or_sends_token: noul(
    'Would carrying out `call` output or transmit an API key, access token, password or private key?',
    'A secret value would appear in the output or be sent somewhere',
    'No secret value would be shown or sent',
  ),
}

export const RELEVANCE = {
  needed_for_task: noul(
    'Is reading the source code named in `call` plausibly needed to do what `task` asks?',
    'The file is named by the task or belongs to the feature, bug, module or area the task is about',
    'The file belongs to an area of the codebase the task has nothing to do with',
  ),
  needed_for_implied_subtask: noul(
    'Is reading the source code named in `call` plausibly needed for a step the task implies?',
    'It could hold callers, dependencies, types, tests, shared utilities, entry points or conventions the work must follow',
    'No step toward the task would need this file',
  ),
} as const

const CREDENTIAL_IDS: readonly CredentialQuestionId[] = [
  'reveals_env_values',
  'reads_secret_store',
  'prints_or_sends_token',
]

const callOf = (target: Target): Json => {
  switch (target.kind) {
    case 'file':
      return { tool: target.tool, path: target.path }
    case 'search':
      return { tool: target.tool, searches_under: target.root, pattern: target.pattern }
    case 'command':
      return { tool: 'Bash', command: clip(target.command, 4000) }
    default:
      return absurd(target)
  }
}

/** The state every guard question is asked of: the work and the call, no file contents. */
export const guardState = (
  target: Target,
  work: WorkContext,
  delegated: Option<string>,
): Json => ({
  task: {
    requests: work.prompts,
    ...(delegated.kind === 'some'
      ? { delegated_to_subagent: delegated.value }
      : {}),
  },
  call: callOf(target),
  already_read: work.read,
})

// ---------------------------------------------------------------- judging

type Flag = { readonly question: CredentialQuestionId; readonly reading: Reading }

/**
 * Missing a true yes is the costly error here, so anything short of a clear
 * no counts: the strongest such answer is the evidence.
 */
export const credentialEvidence = (
  band: Band,
  answers: AnswersOf<typeof CREDENTIAL>,
): Option<Evidence> =>
  CREDENTIAL_IDS.map(
    (question): Flag => ({
      question,
      reading: readNoul(band, answers[question].noul),
    }),
  )
    .filter(flag => flag.reading.kind !== 'no')
    .reduce<Option<Evidence>>(
      (worst, flag) =>
        worst.kind === 'some' &&
        worst.value.kind === 'jev' &&
        worst.value.reading.p >= flag.reading.p
          ? worst
          : some({ kind: 'jev', question: flag.question, reading: flag.reading }),
      none,
    )

export type Judged = {
  readonly credential: AnswersOf<typeof CREDENTIAL>
  readonly relevance: Option<AnswersOf<typeof RELEVANCE>>
}

/**
 * Jev's answers, or its failure, as a Decision.
 *
 * A wrong block of a source file costs the work more than a stray read, so a
 * read is irrelevant only when both relevance answers are a clear no. A
 * command Jev could not judge is blocked; a file that passed the rules is not.
 */
export const judge = (
  band: Band,
  target: Target,
  scope: Scope,
  outcome: Result<Judged, JevError>,
): Decision => {
  if (outcome.kind === 'err') {
    return target.kind === 'command'
      ? {
          kind: 'deny',
          cause: {
            kind: 'credential',
            evidence: { kind: 'unverified', error: outcome.error },
          },
        }
      : { kind: 'allow', basis: { kind: 'unjudged', error: outcome.error } }
  }

  const evidence = credentialEvidence(band, outcome.value.credential)

  if (evidence.kind === 'some') {
    return { kind: 'deny', cause: { kind: 'credential', evidence: evidence.value } }
  }

  if (outcome.value.relevance.kind === 'some') {
    const answers = outcome.value.relevance.value
    const task = readNoul(band, answers.needed_for_task.noul)
    const subtask = readNoul(band, answers.needed_for_implied_subtask.noul)

    if (task.kind === 'no' && subtask.kind === 'no') {
      return {
        kind: 'deny',
        cause: { kind: 'irrelevant', p: task.p >= subtask.p ? task.p : subtask.p },
      }
    }
  }

  return scope.kind === 'exempt'
    ? { kind: 'allow', basis: { kind: 'exempt', why: scope.why } }
    : { kind: 'allow', basis: { kind: 'judged' } }
}

// ---------------------------------------------------------------- wording

const describeError = (error: JevError): string => {
  switch (error.kind) {
    case 'unauthorized':
      return 'OpenRouter refused the API key'
    case 'rate-limited':
      return 'OpenRouter rate-limited the request'
    case 'overloaded':
      return 'Jev is overloaded'
    case 'rejected':
      return `OpenRouter answered ${error.status}`
    case 'transport':
      return 'OpenRouter could not be reached'
    case 'malformed':
      return `the reply was not as asked at ${error.at}`
    default:
      return absurd(error)
  }
}

const describeEvidence = (evidence: Evidence): string => {
  switch (evidence.kind) {
    case 'rule':
      return `it matches the ${evidence.rule} rule`
    case 'jev':
      return `Jev put ${evidence.question} at ${evidence.reading.p.toFixed(2)}`
    case 'unverified':
      return `Jev could not judge the command (${describeError(evidence.error)}), and an unjudged command is not run`
    default:
      return absurd(evidence)
  }
}

/** What the model reads in place of the tool's result. */
export const denyText = (decision: Extract<Decision, { kind: 'deny' }>): string => {
  switch (decision.cause.kind) {
    case 'credential':
      return `jev: blocked, because ${describeEvidence(decision.cause.evidence)}. Credentials, secrets and environment variable values are not read in this session; do not retry by another route.`
    case 'irrelevant':
      return `jev: blocked, because this source code looks unrelated to the task (relevance ${decision.cause.p.toFixed(2)}). If the task does need it, tell the user why: they can allow it with /jev allow <path>.`
    default:
      return absurd(decision.cause)
  }
}
