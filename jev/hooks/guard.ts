// The guard's judgment, all of it pure: rules that need no model, the
// questions Jev is asked, and how its answers become a Decision.

import type {
  AnswersOf,
  Band,
  Caution,
  CredentialQuestionId,
  Decision,
  Evidence,
  Exemption,
  JevError,
  Json,
  Noul,
  Option,
  Reading,
  Result,
  RuleId,
  Scope,
  Segment,
  Target,
  Word,
  WorkContext,
} from '../types'
import {
  SYSTEM_BAND,
  absurd,
  clip,
  isUnder,
  none,
  normalize,
  readNoul,
  some,
} from './domain'
import { noul } from './decisions'
import { segmentsOf } from './shell'

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
// A tokenizer's vocabulary and a design system's tokens are not credentials.
const NOT_SECRET = /(^|\/)[^/]*(tokeniz|design[-_.]?tokens?)[^/]*$/i
const DATA_EXTENSION = /\.(json|ya?ml|toml|txt|ini|cfg|conf|properties|xml|csv)$/i
const NO_EXTENSION = /(^|\/)[^/.]+$/

/**
 * `names` says how far a secret-sounding name is trusted to be a file: a path
 * a tool reads is one whatever its extension, while a word of a command or a
 * folder searched under may be `token` the search term or `tokenizer` the
 * package, so there only a data extension counts.
 */
const ruleOf = (path: string, names: 'any-file' | 'data-file'): Option<RuleId> => {
  if (DOTENV.test(path) && !TEMPLATE_ENV.test(path)) {
    return some('dotenv-file')
  }

  if (PRIVATE_KEY.test(path) || SSH_PRIVATE.test(path)) {
    return some('private-key-file')
  }

  if (CREDENTIAL_STORE.test(path)) {
    return some('credential-store-file')
  }

  const isData =
    DATA_EXTENSION.test(path) || (names === 'any-file' && NO_EXTENSION.test(path))

  return SECRET_NAME.test(path) && !NOT_SECRET.test(path) && isData
    ? some('secret-named-file')
    : none
}

/** The rule the path of a file being read breaks, if any. */
export const pathRule = (path: string): Option<RuleId> => ruleOf(path, 'any-file')

/** A jq or property path (`.key`, `.data.key`, `.items[0].key`), not a key file. */
const PROPERTY_PATH = /^\.([\w[\]]+\.)*key$/i

/**
 * The rule a word of a command, or one alternative of a glob, breaks. It is
 * read with and without its wildcards, so `.env*` and `*.pem` are caught.
 */
export const wordRule = (word: string): Option<RuleId> =>
  [word, word.replace(/[*?]+/g, '')].reduce<Option<RuleId>>((found, spelling) => {
    if (found.kind === 'some' || spelling.length === 0) {
      return found
    }

    const rule = ruleOf(spelling, 'data-file')

    return rule.kind === 'some' &&
      rule.value === 'private-key-file' &&
      PROPERTY_PATH.test(spelling)
      ? none
      : rule
  }, none)

/** A glob's `{a,b}` groups written out, one spelling per alternative. */
const alternativesOf = (glob: string): readonly string[] => {
  const open = glob.indexOf('{')
  const close = glob.indexOf('}', open)

  return open < 0 || close < 0
    ? [glob]
    : glob
        .slice(open + 1, close)
        .split(',')
        .flatMap(one =>
          alternativesOf(`${glob.slice(0, open)}${one}${glob.slice(close + 1)}`),
        )
}

/** The rule a search's file filter breaks: any of its alternatives. */
export const globRule = (glob: string): Option<RuleId> =>
  alternativesOf(glob).reduce<Option<RuleId>>(
    (found, part) => (found.kind === 'some' ? found : wordRule(part.trim())),
    none,
  )

// ---------------------------------------------------------------- commands
// A command is read the way the shell would run it (see shell.ts), and each
// word is given a role first: text a command only carries is not a file it
// reads or a variable it prints.

const ENV_DUMP_WORD = /^(printenv|export\s+-p|declare\s+-[xp]|typeset\s+-x)(\s|$)/
// `env`, `set` and `export` print every variable only when given nothing to
// do: `set -e` and `export A=1` print none. A redirect still prints them.
const ENV_ALONE = /^(env(\s+-[A-Za-z0]+)*|set|export)(\s*\d?>.*)?$/
const ENV_IN_CODE = /process\.env|os\.environ|os\.getenv|System\.getenv|ENV\[|\bgetenv\(/
const HARMLESS_VARIABLE =
  /^(PATH|HOME|PWD|OLDPWD|USER|LOGNAME|SHELL|TERM|LANG|LC_ALL|TMPDIR|HOSTNAME|EDITOR|PAGER)$/
const ECHOED_VARIABLE = /\$\{?([A-Z][A-Z0-9_]*)/g
const ECHO = /^(echo|printf)$/
const CREDENTIAL_HELPER =
  /\bsecurity\s+(find|dump)-[a-z-]*(password|keychain)|\bgh\s+auth\s+(token|status\s+.*(-t|--show-token))|\baws\s+configure\s+(get|list|export-credentials)|\bgcloud\s+auth\s+(application-default\s+)?print-(access|identity)-token|\bop\s+(read|item\s+get)\b|\bpass\s+show\b|\bvault\s+(kv\s+get|read)\b|\bgit\s+credential\s+fill|\bkubectl\s+(get\s+secrets?|config\s+view\s+.*--raw)|\bnpm\s+token\b|\bheroku\s+auth:token/

// Words that come before a command's name without being it.
const LEADING = /^(if|then|else|elif|do|while|until|!|\{|time|exec|command|builtin|nohup|sudo)$/
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/
const DECLARER = /^(export|local|declare|readonly|typeset)$/

type Command = {
  readonly name: string
  readonly args: readonly Word[]
  /** The `NAME=value` words set before the name. */
  readonly assigned: readonly Word[]
}

/** The text of the word at `at`; empty when there is none there. */
const textAt = (words: readonly Word[], at: number): string =>
  at < 0
    ? ''
    : words
        .slice(at, at + 1)
        .map(word => word.text)
        .join('')

const commandOf = (segment: Segment): Command => {
  const lead = segment.words.findIndex(
    word => !LEADING.test(word.text) && !ASSIGNMENT.test(word.text),
  )
  const at = lead < 0 ? segment.words.length : lead

  return {
    name: textAt(segment.words, at),
    args: segment.words.slice(at + 1),
    assigned: segment.words.slice(0, at).filter(word => ASSIGNMENT.test(word.text)),
  }
}

/**
 * What a word is to the command that holds it: `kept` is read as the command
 * line it is; `text` is prose or a pattern the command only carries; `code`
 * is a script for an interpreter; `shell` is a command line run by a shell.
 */
type Role = 'kept' | 'text' | 'code' | 'shell'

const SEARCHER = /^(grep|egrep|fgrep|rg|ag|ack)$/
const PATTERN_FLAG = /^(-e|--regexp)$/
const PATTERN_FILE_FLAG = /^(-f|--file)$/
// Flags whose next word is their value, so not the pattern.
const SEARCH_VALUE_FLAG =
  /^(-[ABCmgtTdj]|--max-count|--glob|--include|--exclude|--exclude-dir|--type|--max-depth|--context|--after-context|--before-context)$/

/** A search's pattern is text: its first operand, or what follows each `-e`. */
const searchRoles = (args: readonly Word[]): readonly Role[] => {
  const isFlagged = args.some(
    arg => PATTERN_FLAG.test(arg.text) || PATTERN_FILE_FLAG.test(arg.text),
  )
  const patternAt = isFlagged
    ? -1
    : args.findIndex(
        (arg, at) =>
          !arg.text.startsWith('-') && !SEARCH_VALUE_FLAG.test(textAt(args, at - 1)),
      )

  return args.map((_, at) =>
    at === patternAt || PATTERN_FLAG.test(textAt(args, at - 1)) ? 'text' : 'kept',
  )
}

const MESSAGE_FLAG = /^(-[A-Za-z]*m|--message|--body|--title|--notes)$/
const GH_MESSAGE_FLAG = /^(-[bt]|--body|--title|--notes)$/
const MESSAGE_INLINE = /^--(message|body|title|notes)=/

/** The value of a message flag is prose about the work. */
const messageRoles = (args: readonly Word[], flag: RegExp): readonly Role[] =>
  args.map((arg, at) =>
    flag.test(textAt(args, at - 1)) || MESSAGE_INLINE.test(arg.text) ? 'text' : 'kept',
  )

const HISTORY_FLAG = /^(--grep|--author|-S|-G)$/
const HISTORY_INLINE = /^(--grep=|--author=|-[SG].)/

const historyRoles = (args: readonly Word[]): readonly Role[] =>
  args.map((arg, at) =>
    HISTORY_FLAG.test(textAt(args, at - 1)) || HISTORY_INLINE.test(arg.text)
      ? 'text'
      : 'kept',
  )

const GIT_VALUE_FLAG = /^-[Cc]$/

/** Where git's subcommand sits among its arguments; -1 when it has none. */
const gitSubAt = (args: readonly Word[]): number =>
  args.findIndex(
    (arg, at) => !arg.text.startsWith('-') && !GIT_VALUE_FLAG.test(textAt(args, at - 1)),
  )

const INTERPRETER = /^(node|nodejs|bun|deno|tsx|ts-node|python|python2|python3|ruby|perl|php)$/
const SHELL = /^(bash|sh|zsh|dash|ksh)$/
const SHELL_COMMAND_FLAG = /^-[a-z]*c$/

/** The flag after which an interpreter takes its script on the command line. */
const codeFlagOf = (name: string): RegExp => {
  if (name.startsWith('python')) {
    return /^-c$/
  }

  return name === 'php' ? /^-r$/ : /^(-[a-z]*[ep]|--eval|--print)$/
}

const kept = (args: readonly Word[]): readonly Role[] => args.map((): Role => 'kept')

const rolesOf = (name: string, args: readonly Word[]): readonly Role[] => {
  if (SEARCHER.test(name)) {
    return searchRoles(args)
  }

  if (name === 'git') {
    const at = gitSubAt(args)
    const sub = textAt(args, at)
    const head = kept(args.slice(0, at + 1))
    const rest = args.slice(at + 1)

    if (sub === 'grep') {
      return [...head, ...searchRoles(rest)]
    }

    if (/^(commit|tag|notes)$/.test(sub)) {
      return [...head, ...messageRoles(rest, MESSAGE_FLAG)]
    }

    return /^(log|diff|show)$/.test(sub) ? [...head, ...historyRoles(rest)] : kept(args)
  }

  if (name === 'gh') {
    return /^(pr|issue|release)$/.test(textAt(args, 0)) &&
      /^(create|edit|comment|review)$/.test(textAt(args, 1))
      ? messageRoles(args, GH_MESSAGE_FLAG)
      : kept(args)
  }

  if (INTERPRETER.test(name)) {
    const flag = codeFlagOf(name)

    return args.map((_, at) => (flag.test(textAt(args, at - 1)) ? 'code' : 'kept'))
  }

  if (SHELL.test(name)) {
    return args.map((_, at) =>
      SHELL_COMMAND_FLAG.test(textAt(args, at - 1)) ? 'shell' : 'kept',
    )
  }

  return name === 'eval' ? args.map((): Role => 'shell') : kept(args)
}

// What a heredoc is fed to decides what its body is: these only carry it.
const TEXT_READER = /^(cat|tee|git|gh)$/
const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g

/** One command as the rules read it. */
type Read = {
  readonly name: string
  /** The name and the words kept, as one line. */
  readonly line: string
  /** Every word that could name a file. */
  readonly files: readonly string[]
  /** Scripts an interpreter would run. */
  readonly code: readonly string[]
  /** Command lines a shell would run. */
  readonly shell: readonly string[]
  /** Whether it prints a variable that may hold a secret. */
  readonly echoes: boolean
}

const namesIn = (texts: readonly string[]): readonly string[] =>
  texts
    .flatMap(text => text.split(/[\s=<>|;&()]+/))
    .map(word => word.replace(/^@+/, ''))
    .filter(word => word.length > 0)

/** The upper-case variables a text refers to that are not known to be harmless. */
const riskyIn = (text: string, safe: readonly string[]): readonly string[] =>
  [...text.matchAll(ECHOED_VARIABLE)]
    .map(([, name = '']) => name)
    .filter(name => !HARMLESS_VARIABLE.test(name) && !safe.includes(name))

type Setting = { readonly name: string; readonly values: readonly Word[] }

/** The variables a command sets, each with the words its value comes from. */
const settingsOf = (command: Command): readonly Setting[] => {
  const assigned = (words: readonly Word[]): readonly Setting[] =>
    words.flatMap(word =>
      [...word.text.matchAll(new RegExp(ASSIGNMENT, 'g'))].map(
        ([, name = '', value = '']): Setting => ({
          name,
          values: [{ kind: word.kind, text: value }],
        }),
      ),
    )

  if (DECLARER.test(command.name)) {
    return [...assigned(command.assigned), ...assigned(command.args)]
  }

  if (command.name === 'for') {
    return [
      ...assigned(command.assigned),
      { name: textAt(command.args, 0), values: command.args.slice(1) },
    ]
  }

  return command.name === 'read'
    ? [
        ...assigned(command.assigned),
        ...command.args
          .filter(arg => !arg.text.startsWith('-'))
          .map((arg): Setting => ({ name: arg.text, values: [] })),
      ]
    : assigned(command.assigned)
}

/**
 * The variables known to be harmless after a command: one it sets from
 * nothing risky joins them, and one it sets from a risky variable leaves.
 */
const safeAfter = (safe: readonly string[], command: Command): readonly string[] =>
  settingsOf(command).reduce<readonly string[]>((known, setting) => {
    const others = known.filter(name => name !== setting.name)
    const isRisky = setting.values.some(
      word => word.kind === 'expanding' && riskyIn(word.text, known).length > 0,
    )

    return isRisky ? others : [...others, setting.name]
  }, safe)

const readOf = (segment: Segment, command: Command, safe: readonly string[]): Read => {
  const roles = rolesOf(command.name, command.args)
  const playing = (role: Role): readonly string[] =>
    command.args.filter((_, at) => roles.at(at) === role).map(arg => arg.text)
  const words = playing('kept')
  const line = [command.name, ...words].join(' ')
  const piped = segment.pipedInto.kind === 'some' ? segment.pipedInto.value : ''
  // `cat <<EOF | sh` hands the body to sh; anything else reads its own.
  const reader = command.name === 'cat' && piped.length > 0 ? piped : command.name
  const body = segment.heredoc.kind === 'some' ? [segment.heredoc.value.body] : []
  const isCarried = TEXT_READER.test(reader)
  const isScript = INTERPRETER.test(reader)
  const code = [
    ...playing('code'),
    ...(isScript ? body : []),
    ...(INTERPRETER.test(piped) && body.length === 0 ? [words.join(' ')] : []),
  ]

  return {
    name: command.name,
    line,
    files: namesIn([
      command.name,
      ...words,
      ...command.assigned.map(word => word.text),
      ...code.flatMap(script =>
        [...script.matchAll(STRING_LITERAL)].map(
          ([, single = '', double = '', ticked = '']) => `${single}${double}${ticked}`,
        ),
      ),
    ]),
    code,
    shell: [
      ...playing('shell'),
      ...(isCarried || isScript ? [] : body),
      ...(SHELL.test(piped) && body.length === 0 ? [words.join(' ')] : []),
    ],
    echoes:
      ECHO.test(command.name) &&
      command.args.some(
        arg => arg.kind === 'expanding' && riskyIn(arg.text, safe).length > 0,
      ),
  }
}

type Fold = { readonly safe: readonly string[]; readonly reads: readonly Read[] }

/** Every command a command line runs, the ones a shell inside it runs included. */
const readsOf = (given: string): readonly Read[] =>
  segmentsOf(given)
    .reduce<Fold>(
      (fold, segment) => {
        const command = commandOf(segment)
        const read = readOf(segment, command, fold.safe)

        return {
          safe: safeAfter(fold.safe, command),
          reads: [...fold.reads, read, ...read.shell.flatMap(readsOf)],
        }
      },
      { safe: [], reads: [] },
    )
    .reads

/** The rule a shell command breaks, if any. */
export const commandRule = (given: string): Option<RuleId> => {
  const reads = readsOf(given)

  if (
    reads.some(
      read =>
        ENV_DUMP_WORD.test(read.line) ||
        ENV_ALONE.test(read.line) ||
        read.code.some(script => ENV_IN_CODE.test(script)),
    )
  ) {
    return some('environment-dump')
  }

  if (reads.some(read => read.echoes)) {
    return some('environment-variable-echo')
  }

  if (reads.some(read => CREDENTIAL_HELPER.test(read.line))) {
    return some('credential-helper')
  }

  // Any word that names a credential file, whatever the command does with it.
  return reads.some(read => read.files.some(word => wordRule(word).kind === 'some'))
    ? some('credential-file-reader')
    : none
}

// ---------------------------------------------------------------- caution

const HARMLESS: readonly string[] = ['PATH', 'HOME', 'PWD', 'USER', 'TMPDIR']

const ROUTINE_GIT =
  /^(add|commit|push|pull|fetch|status|diff|log|show|branch|checkout|switch|merge|rebase|stash|tag|restore|rm|mv)$/
const ROUTINE_GH = /^(create|view|list|status|checks|edit|comment|diff)$/
const ROUTINE_PLAIN = /^(ls|pwd|cd|mkdir|wc|echo|printf|true|tsc)$/
const ROUTINE_FILTER = /^(head|tail|sort|uniq)$/
const ROUTINE_SCRIPT = /^(run|test|t|install|i|ci)$/

/** Whether every variable a word expands is one the command set from nothing risky. */
const expandsOnly = (safe: readonly string[], word: Word): boolean =>
  word.kind !== 'expanding' ||
  [...word.text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].every(([, name = '']) =>
    safe.includes(name),
  )

const isRoutine = (segment: Segment, safe: readonly string[]): boolean => {
  const command = commandOf(segment)
  const { name, args } = command
  const holdsText =
    segment.heredoc.kind === 'none' || segment.heredoc.value.kind === 'literal'

  if (!segment.words.every(word => expandsOnly(safe, word)) || !holdsText) {
    return false
  }

  // `BRANCH=$(git branch --show-current)`: only sets a variable.
  if (name === '') {
    return command.assigned.length > 0
  }

  if (name === 'git') {
    return ROUTINE_GIT.test(textAt(args, gitSubAt(args)))
  }

  if (name === 'gh') {
    return /^(pr|issue)$/.test(textAt(args, 0)) && ROUTINE_GH.test(textAt(args, 1))
  }

  if (segment.heredoc.kind === 'some') {
    // Only as the text of a message: `cat <<'EOF'` inside a `$(...)`.
    return name === 'cat' && args.length === 0 && segment.pipedInto.kind === 'none'
  }

  if (/^(npm|pnpm|yarn|bun)$/.test(name)) {
    return ROUTINE_SCRIPT.test(textAt(args, 0))
  }

  if (name === 'npx') {
    return textAt(args, 0) === 'tsc'
  }

  if (name === 'claude') {
    return textAt(args, 0) === 'plugin' && /^(validate|test)$/.test(textAt(args, 1))
  }

  if (ROUTINE_FILTER.test(name)) {
    // A filter on a pipe, given only flags: with a file it would read it.
    return args.every(arg => /^-|^\d+$/.test(arg.text))
  }

  return ROUTINE_PLAIN.test(name)
}

/**
 * How much doubt blocks a call. A command made only of everyday git, package
 * and listing commands, with nothing expanded into it, is `routine`: Jev is
 * still asked about it, but only a clear yes stops it.
 */
export const cautionOf = (target: Target): Caution => {
  switch (target.kind) {
    case 'file':
    case 'search':
      return 'strict'
    case 'command': {
      const segments = segmentsOf(target.command)
      const fold = segments.reduce(
        (state, segment) => ({
          safe: safeAfter(state.safe, commandOf(segment)),
          routine: state.routine && isRoutine(segment, state.safe),
        }),
        { safe: HARMLESS, routine: segments.length > 0 },
      )

      return fold.routine ? 'routine' : 'strict'
    }
    default:
      return absurd(target)
  }
}

// ---------------------------------------------------------------- width

/**
 * Whether a search starting at `path` is wider than work on a project needs:
 * the root, a top-level folder, or a folder that holds the home folder.
 */
export const isWideRoot = (path: string, home: Option<string>): boolean => {
  if (home.kind === 'some' && path === home.value) {
    return false
  }

  return (
    path.split('/').filter(part => part.length > 0).length <= 1 ||
    (home.kind === 'some' && isUnder(path, home.value))
  )
}

/** A word as the absolute path it names, where that can be told. */
const pathOf = (
  text: string,
  home: Option<string>,
  cwd: Option<string>,
): Option<string> => {
  const spelled = text
    .replace(/\/\*+$/, '/')
    .replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home.kind === 'some' ? home.value : '~')

  if (spelled.startsWith('/')) {
    return some(normalize(spelled))
  }

  return cwd.kind === 'some' && !spelled.startsWith('~')
    ? some(normalize(`${cwd.value}/${spelled}`))
    : none
}

const WALKER = /^(find|du|tree)$/
const MATCHER = /^(rg|ag|ack|fd|fdfind)$/
const GREP = /^(grep|egrep|fgrep)$/
const RECURSIVE = /^(-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive)$/
const LISTS_ALL = /^-[A-Za-z]*R[A-Za-z]*$/

type Walk =
  | { readonly kind: 'none' }
  /** `bare` is how many operands it may have and still search where it stands. */
  | { readonly kind: 'walk'; readonly operands: readonly string[]; readonly bare: number }
  | { readonly kind: 'index' }

/** What a command searches: named folders, or the machine's whole index. */
const walkOf = ({ name, args }: Command): Walk => {
  const texts = args.map(arg => arg.text)
  const operands = texts.filter(text => !text.startsWith('-'))

  if (name === 'find') {
    const firstFlag = texts.findIndex(text => /^[-(!]/.test(text))

    return {
      kind: 'walk',
      operands: firstFlag < 0 ? texts : texts.slice(0, firstFlag),
      bare: 0,
    }
  }

  if (WALKER.test(name) || (name === 'ls' && texts.some(text => LISTS_ALL.test(text)))) {
    return { kind: 'walk', operands, bare: 0 }
  }

  if (MATCHER.test(name) || (GREP.test(name) && texts.some(text => RECURSIVE.test(text)))) {
    // The first operand is the pattern; the folders follow it.
    return { kind: 'walk', operands: operands.slice(1), bare: 0 }
  }

  if (/^(locate|plocate)$/.test(name) || (name === 'mdfind' && !texts.includes('-onlyin'))) {
    return { kind: 'index' }
  }

  return { kind: 'none' }
}

type Wandering = { readonly cwd: Option<string>; readonly found: Option<string> }

/** The too-wide folder a command searches from, if it searches from one. */
const wideIn = (command: string, home: Option<string>): Option<string> =>
  segmentsOf(command)
    .map(commandOf)
    .reduce<Wandering>(
      (state, one) => {
        if (state.found.kind === 'some') {
          return state
        }

        if (one.name === 'cd') {
          const to = pathOf(textAt(one.args, 0), home, state.cwd)

          // Only a too-wide folder is worth remembering as where it stands.
          return {
            ...state,
            cwd: to.kind === 'some' && isWideRoot(to.value, home) ? to : none,
          }
        }

        const walk = walkOf(one)

        switch (walk.kind) {
          case 'none':
            return state
          case 'index':
            return { ...state, found: some('/') }
          case 'walk': {
            const named = walk.operands.reduce<Option<string>>((found, operand) => {
              const path = pathOf(operand, home, state.cwd)

              return found.kind === 'none' &&
                path.kind === 'some' &&
                isWideRoot(path.value, home)
                ? path
                : found
            }, none)

            return {
              ...state,
              found:
                named.kind === 'none' && walk.operands.length <= walk.bare
                  ? state.cwd
                  : named,
            }
          }
          default:
            return absurd(walk)
        }
      },
      { cwd: none, found: none },
    ).found

/** The folder an absolute glob starts from: its path up to the first wildcard. */
const globBase = (pattern: string): Option<string> => {
  const parts = pattern.split('/')
  const wild = parts.findIndex(part => /[*?[{]/.test(part))

  return pattern.startsWith('/')
    ? some(normalize(parts.slice(0, wild < 0 ? parts.length : wild).join('/')))
    : none
}

/** The too-wide folder a call searches from, if it searches from one. */
export const wideRootOf = (target: Target, home: Option<string>): Option<string> => {
  switch (target.kind) {
    case 'file':
      return none
    case 'search': {
      if (isWideRoot(target.root, home)) {
        return some(target.root)
      }

      const base = target.tool === 'Glob' ? globBase(target.pattern) : none

      return base.kind === 'some' && isWideRoot(base.value, home) ? base : none
    }
    case 'command':
      return wideIn(target.command, home)
    default:
      return absurd(target)
  }
}

export const ruleFor = (target: Target): Option<RuleId> => {
  switch (target.kind) {
    case 'file': {
      const real = pathRule(target.path)

      // A link is judged by where it points and by what it is called.
      return real.kind === 'some' ? real : pathRule(target.asked)
    }
    case 'search': {
      // What is searched for is text, not a path: only where the search
      // reads counts, which is its root and its file filter.
      const root = ruleOf(target.root, 'data-file')

      if (root.kind === 'some' || target.tool === 'Glob' || target.glob.kind === 'none') {
        return root
      }

      return globRule(target.glob.value)
    }
    case 'command':
      return commandRule(target.command)
    default:
      return absurd(target)
  }
}

/** The first rule any file of a call breaks. */
export const ruleForAll = (targets: readonly Target[]): Option<RuleId> =>
  targets.reduce<Option<RuleId>>(
    (found, target) => (found.kind === 'some' ? found : ruleFor(target)),
    none,
  )

// ---------------------------------------------------------------- scope

const SOURCE_FILE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|php|scala|sh|bash|zsh|pl|lua|r|m|mm|dart|ex|exs|erl|hs|clj|cljs|elm|vue|svelte|sql|zig|nim|ml|fs)$/i
const FILE_READER = /^(cat|head|tail|less|more|bat|nl|sed|awk|xxd|strings|od)$/

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
 * What a call is asked about besides credentials. A search from a too-wide
 * folder is asked whether the task needs the whole system. Otherwise only
 * source code inside the session's root, resolved as the read's own path is,
 * is held to relevance: docs, manifests, config, searches and anything outside
 * the root are how a task is found, and are never blocked for it.
 */
export const scopeOf = (
  target: Target,
  root: string,
  home: Option<string>,
  work: WorkContext,
): Scope => {
  const wide = wideRootOf(target, home)

  // The project is never too wide to search, even at `/app` or `/repo`.
  if (wide.kind === 'some' && !isUnder(root, wide.value)) {
    return { kind: 'wide', root: wide.value }
  }

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

      // Allowed as it resolves or as it was asked for: a path given through
      // a link is the one the person sees.
      if (
        isAllowed(work.allowed, target.path) ||
        isAllowed(work.allowed, target.asked)
      ) {
        return { kind: 'exempt', why: 'allow-listed' }
      }

      return SOURCE_FILE.test(target.path)
        ? { kind: 'judge' }
        : { kind: 'exempt', why: 'not-source' }
    case 'command': {
      const sources = readsOf(target.command)
        .filter(read => FILE_READER.test(read.name))
        .flatMap(read => read.files)
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

export const SYSTEM = {
  needs_system_wide_search: noul(
    'Does `task` say or imply a real need to search, inspect or change the machine as a whole, outside the project and the user\'s own folders, as `call` would?',
    'The requests ask for a system fix, a system query or a system change, or cannot be done without looking across the whole machine',
    'The requests are about a project or the user\'s own files, and searching under the project or the home folder would serve them',
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
      return {
        tool: target.tool,
        searches_under: target.root,
        pattern: target.pattern,
        ...(target.tool === 'Grep' && target.glob.kind === 'some'
          ? { only_files_matching: target.glob.value }
          : {}),
      }
    case 'command':
      return { tool: target.tool, command: clip(target.command, 4000) }
    default:
      return absurd(target)
  }
}

/** The state every guard question is asked of: the work and the call, no file contents. */
export const guardState = (
  target: Target,
  more: readonly Target[],
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
  ...(more.length > 0 ? { call_also_reads: more.map(callOf) } : {}),
  already_read: work.read,
})

// ---------------------------------------------------------------- judging

type Flag = { readonly question: CredentialQuestionId; readonly reading: Reading }

/**
 * Missing a true yes is the costly error here, so anything short of a clear
 * no counts: the strongest such answer is the evidence. A routine command is
 * the exception, where a wrong block stops everyday work: only a yes counts.
 */
export const credentialEvidence = (
  band: Band,
  caution: Caution,
  answers: AnswersOf<typeof CREDENTIAL>,
): Option<Evidence> =>
  CREDENTIAL_IDS.map(
    (question): Flag => ({
      question,
      reading: readNoul(band, answers[question].noul),
    }),
  )
    .filter(flag =>
      caution === 'routine' ? flag.reading.kind === 'yes' : flag.reading.kind !== 'no',
    )
    .reduce<Option<Evidence>>(
      (worst, flag) =>
        worst.kind === 'some' &&
        worst.value.kind === 'jev' &&
        worst.value.reading.p >= flag.reading.p
          ? worst
          : some({ kind: 'jev', question: flag.question, reading: flag.reading }),
      none,
    )

type Credentials = AnswersOf<typeof CREDENTIAL>

/** What Jev was asked about a call, with its answers or its failure. */
export type Asked =
  | {
      readonly kind: 'judge'
      readonly outcome: Result<Credentials & AnswersOf<typeof RELEVANCE>, JevError>
    }
  | {
      readonly kind: 'exempt'
      readonly why: Exemption
      readonly outcome: Result<Credentials, JevError>
    }
  | {
      readonly kind: 'wide'
      readonly root: string
      readonly outcome: Result<Credentials & AnswersOf<typeof SYSTEM>, JevError>
    }

const denied = (evidence: Evidence): Decision => ({
  kind: 'deny',
  cause: { kind: 'credential', evidence },
})

/** Jev did not answer: a command that is not routine is not run; the rest is. */
const unanswered = (target: Target, error: JevError): Decision =>
  target.kind === 'command' && cautionOf(target) === 'strict'
    ? denied({ kind: 'unverified', error })
    : { kind: 'allow', basis: { kind: 'unjudged', error } }

/**
 * Jev's answers, or its failure, as a Decision.
 *
 * A wrong block of a source file costs the work more than a stray read, so a
 * read is irrelevant only when both relevance answers are a clear no. A
 * command Jev could not judge is blocked unless it is routine; a file that
 * passed the rules is not. A too-wide search runs only on a clear yes that
 * the task needs the whole system, so not when Jev could not be asked.
 */
export const judge = (band: Band, target: Target, asked: Asked): Decision => {
  const caution = cautionOf(target)

  switch (asked.kind) {
    case 'wide': {
      if (asked.outcome.kind === 'err') {
        return {
          kind: 'deny',
          cause: {
            kind: 'wide-search',
            root: asked.root,
            why: { kind: 'unverified', error: asked.outcome.error },
          },
        }
      }

      const answers = asked.outcome.value
      const evidence = credentialEvidence(band, caution, answers)

      if (evidence.kind === 'some') {
        return denied(evidence.value)
      }

      const reading = readNoul(SYSTEM_BAND, answers.needs_system_wide_search.noul)

      return reading.kind === 'yes'
        ? { kind: 'allow', basis: { kind: 'system-task' } }
        : {
            kind: 'deny',
            cause: {
              kind: 'wide-search',
              root: asked.root,
              why: { kind: 'jev', reading },
            },
          }
    }
    case 'judge': {
      if (asked.outcome.kind === 'err') {
        return unanswered(target, asked.outcome.error)
      }

      const answers = asked.outcome.value
      const evidence = credentialEvidence(band, caution, answers)

      if (evidence.kind === 'some') {
        return denied(evidence.value)
      }

      const task = readNoul(band, answers.needed_for_task.noul)
      const subtask = readNoul(band, answers.needed_for_implied_subtask.noul)

      return task.kind === 'no' && subtask.kind === 'no'
        ? {
            kind: 'deny',
            cause: { kind: 'irrelevant', p: task.p >= subtask.p ? task.p : subtask.p },
          }
        : { kind: 'allow', basis: { kind: 'judged' } }
    }
    case 'exempt': {
      if (asked.outcome.kind === 'err') {
        return unanswered(target, asked.outcome.error)
      }

      const evidence = credentialEvidence(band, caution, asked.outcome.value)

      return evidence.kind === 'some'
        ? denied(evidence.value)
        : { kind: 'allow', basis: { kind: 'exempt', why: asked.why } }
    }
    default:
      return absurd(asked)
  }
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

type Wide = Extract<Extract<Decision, { kind: 'deny' }>['cause'], { kind: 'wide-search' }>

const describeWide = (why: Wide['why']): string => {
  switch (why.kind) {
    case 'jev':
      return `Jev put the need for a system-wide search at ${why.reading.p.toFixed(2)}`
    case 'unverified':
      return `Jev could not judge it: ${describeError(why.error)}`
    default:
      return absurd(why)
  }
}

/** What the model reads in place of the tool's result. */
export const denyText = (decision: Extract<Decision, { kind: 'deny' }>): string => {
  switch (decision.cause.kind) {
    case 'credential':
      return `jev: blocked, because ${describeEvidence(decision.cause.evidence)}. Credentials, secrets and environment variable values are not read in this session; do not retry by another route.`
    case 'irrelevant':
      return `jev: blocked, because this source code looks unrelated to the task (relevance ${decision.cause.p.toFixed(2)}). If the task does need it, tell the user why: they can allow it with /jev allow <path>.`
    case 'wide-search':
      return `jev: blocked, because this search starts at ${decision.cause.root}, which is wider than the task needs (${describeWide(decision.cause.why)}). Search under the project or the home folder instead. If the task does need the whole system searched, tell the user why: they can ask for it in their next prompt.`
    default:
      return absurd(decision.cause)
  }
}
