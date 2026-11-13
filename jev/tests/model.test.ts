// The data model on its own: decoding, reading nouls, rules, judging, routing.
// The JSON here is as TypeSafe's docs record Jev's replies.

import { expect, test } from 'claude-code/testing'

import type { JevError, Ledger, Probability, WorkContext } from '../types'
import { rowsOf, textOf } from '../hooks/band'
import { decodeDecided } from '../hooks/boundary'
import {
  DEFAULT_BAND,
  FIRST_ROUTE,
  INITIAL,
  ROUTE_AT_LEAST,
  SYSTEM_BAND,
  TIER_MODEL,
  addClaude,
  applyDecision,
  lineOf,
  priceOf,
  usageOf,
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
import {
  CREDENTIAL,
  RELEVANCE,
  SYSTEM,
  cautionOf,
  commandRule,
  denyText,
  isWideRoot,
  judge,
  pathRule,
  ruleFor,
  scopeOf,
} from '../hooks/guard'
import { segmentsOf as shellSegments } from '../hooks/shell'
import { ROUTE, SPAWN, routeOf, spawnOf } from '../hooks/routing'

const p = (n: number): Probability => {
  const made = probability(n)

  if (made.kind === 'none') {
    throw new Error(`${n} is not a probability`)
  }

  return made.value
}

const noul = (n: number) => ({ type: 'noul', noul: n })

const HOME = some('/Users/x')

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

test('the rules leave ordinary commands and searches alone', () => {
  // `set -e` prints nothing; `set`, `export` and a redirected `env` print it all.
  expect(commandRule('set -e\ncd app\nnpm test')).toEqual(none)
  expect(commandRule('set -x && make')).toEqual(none)
  expect(commandRule('export NODE_ENV=test && npm test')).toEqual(none)
  expect(commandRule('set')).toEqual(some('environment-dump'))
  expect(commandRule('env > /tmp/all')).toEqual(some('environment-dump'))
  expect(commandRule('export')).toEqual(some('environment-dump'))

  // A word that sounds like a secret is a file only with a data extension.
  expect(commandRule('git commit -m "fix token refresh"')).toEqual(none)
  expect(commandRule('cd packages/tokenizer && npm test')).toEqual(none)
  expect(commandRule('pytest -k token')).toEqual(none)
  expect(commandRule("jq '.data.key' out.json")).toEqual(none)
  expect(commandRule('cat config/secrets.yaml')).toEqual(some('credential-file-reader'))
  expect(commandRule('openssl rsa -in server.key')).toEqual(some('credential-file-reader'))

  // Wildcards do not hide a credential file.
  expect(commandRule('cat .env*')).toEqual(some('credential-file-reader'))
  expect(commandRule('cat certs/*.pem')).toEqual(some('credential-file-reader'))

  // Searching for the text is not reading the environment.
  expect(commandRule('grep -rn "process.env" src')).toEqual(none)
  expect(commandRule('node -e "console.log(process.env)"')).toEqual(some('environment-dump'))
})

const heredocCommit = (body: string) =>
  `git add jev && git commit -m "$(cat <<'EOF'\n${body}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`

test('the words of a commit or PR message are text, not commands or files', () => {
  // The bug: each message line was read as a command of its own.
  expect(commandRule(heredocCommit('Stop reading process.env in the band'))).toEqual(none)
  expect(commandRule(heredocCommit('Block .env, .npmrc and secrets.json reads'))).toEqual(none)
  expect(commandRule(heredocCommit('export\nset\necho $OPENROUTER_API_KEY is never shown'))).toEqual(none)
  expect(commandRule(`git commit -m 'Guard id_rsa and *.pem reads'`)).toEqual(none)
  expect(commandRule('git commit -m "Ignore .env.local" && git push origin main')).toEqual(none)
  expect(commandRule('git tag -a v1 --message="secrets.yaml rule"')).toEqual(none)
  expect(
    commandRule(`gh pr create --title "Guard .env" --body "$(cat <<"EOF"\nprintenv is blocked\nEOF\n)"`),
  ).toEqual(none)
})

test('a message that runs something is still read as a command', () => {
  expect(commandRule('git commit -m "$(cat .env)"')).toEqual(some('credential-file-reader'))
  expect(commandRule('git commit -m "$(cat ~/.npmrc)"')).toEqual(some('credential-file-reader'))
  expect(commandRule('git commit -m "$OPENROUTER_API_KEY" && echo $OPENROUTER_API_KEY')).toEqual(
    some('environment-variable-echo'),
  )
  expect(commandRule('cat .env && git commit -m x')).toEqual(some('credential-file-reader'))
  // An unquoted delimiter expands its body; a shell runs its body; a pipe runs cat's text.
  expect(commandRule('git commit -F- <<EOF\n$(cat ~/.npmrc)\nEOF')).toEqual(some('credential-file-reader'))
  expect(commandRule("bash <<'EOF'\nprintenv\nEOF")).toEqual(some('environment-dump'))
  expect(commandRule("cat <<'EOF' | sh\nprintenv\nEOF")).toEqual(some('environment-dump'))
})

test('a command is read as the shell reads it: quotes, substitutions and heredocs', () => {
  const read = (command: string) =>
    shellSegments(command).map(segment => segment.words.map(word => word.text).join(' '))

  // An operator inside quotes is text; outside, it ends the command.
  expect(read('grep -E "env|set" a.txt | sort; echo \'a && b\'')).toEqual([
    'grep -E env|set a.txt',
    'sort',
    'echo a && b',
  ])
  expect(read('npm test 2>&1 | tail -3')).toEqual(['npm test 2>&1', 'tail -3'])
  // What a substitution runs is a command of its own, wherever it sits.
  expect(read('git commit -m "a $(cat `which x`) b"')).toEqual(['git commit -m a $() b', 'cat $()', 'which x'])

  const [commit, , cat] = shellSegments("git commit -m \"$(cat <<'EOF'\ndon't (ever) | read\nEOF\n)\" && git push")
  expect(commit?.words.map(word => word.kind)).toEqual(['literal', 'literal', 'literal', 'substituting'])
  expect(cat?.heredoc).toEqual(some({ kind: 'literal', body: "don't (ever) | read" }))
  expect(shellSegments('echo "$A" \'$B\' $(c)').flatMap(segment => segment.words.map(word => word.kind))).toEqual([
    'literal',
    'expanding',
    'literal',
    'substituting',
    'literal',
  ])

  // An unquoted delimiter expands its body, unless there is nothing to expand.
  expect(shellSegments('cat <<EOF\nplain\nEOF')[0]?.heredoc).toEqual(some({ kind: 'literal', body: 'plain' }))
  expect(shellSegments('cat <<EOF\n$(id) $X\nEOF').map(segment => segment.words[0].text)).toEqual(['cat', 'id'])
  expect(shellSegments('cat <<EOF\n$X\nEOF')[0]?.heredoc).toEqual(some({ kind: 'expanding', body: '$X' }))
  expect(shellSegments("cat <<'EOF' | sh\nid\nEOF")[0]?.pipedInto).toEqual(some('sh'))
  expect(shellSegments('')).toEqual([])
})

test('commits, pushes and searches that only mention secrets are left alone', () => {
  const free = [
    "git commit -q -F - <<'EOF'\nGuard .env reads\n\n- process.env is not read\nexport\nEOF",
    'git commit -F - <<EOF\nStop printenv and secrets.json reads\nEOF',
    "gh pr create --title x --body-file - <<'EOF'\nBlocks .npmrc\nEOF",
    'git commit -am "Ignore .env.local"',
    'git add -A && git commit -m "Fix `process.env` read" && git push',
    'gh pr create -t "Guard .env" -b "printenv is blocked"',
    'F=$(ls -t a | head -1); echo $F; wc -l $F',
    'BRANCH=$(git branch --show-current) && git push -u origin "$BRANCH" && echo "pushed $BRANCH"',
    'for F in a b; do echo "$F"; done',
    'grep -E "env|set|export" file.txt',
    'rg "secrets.json|.npmrc" README.md',
    'grep -n -A 3 -e "id_rsa" -e ".env" README.md',
    'git log --grep "secrets.yaml" -S ".npmrc" --oneline',
    'git grep -n "process.env" -- src',
    "sed -i '' 's/process.env.PORT/port/' src/server.ts",
    "node -e 'console.log(e.key)'",
    'cat design-tokens.json',
    'cat models/tokenizer.json',
    'git add .env.example .gitignore && git commit -m x',
    'npm test 2>&1 | tail -40',
    'echo \'$OPENROUTER_API_KEY is never shown\'',
  ]

  for (const command of free) {
    expect([command, commandRule(command)]).toEqual([command, none])
  }
})

test('what a command runs, reads or prints is still caught through any wrapping', () => {
  const caught: readonly (readonly [string, string])[] = [
    ['X=$OPENROUTER_API_KEY; echo $X', 'environment-variable-echo'],
    ['X=1; X=$OPENROUTER_API_KEY; echo "$X"', 'environment-variable-echo'],
    ['for i in 1; do echo $OPENROUTER_API_KEY; done', 'environment-variable-echo'],
    ['FOO=1 printenv', 'environment-dump'],
    ['sudo printenv', 'environment-dump'],
    ["bash -c 'printenv | sort'", 'environment-dump'],
    ["echo 'console.log(process.env)' | node", 'environment-dump'],
    ["python3 <<'PY'\nimport os\nprint(os.environ)\nPY", 'environment-dump'],
    ["python3 -c 'print(open(\".env\").read())'", 'credential-file-reader'],
    ['git commit -F .env', 'credential-file-reader'],
    ['git commit -m "x" -- secrets.yaml', 'credential-file-reader'],
    ['grep -r KEY .env', 'credential-file-reader'],
    ['rg KEY -g ".env*"', 'credential-file-reader'],
    ['git commit -m "$(gh auth token)"', 'credential-helper'],
    ['cat tokens.json', 'credential-file-reader'],
  ]

  for (const [command, rule] of caught) {
    expect([command, commandRule(command)]).toEqual([command, some(rule)])
  }
})

test('a search is judged by where it reads, not by what it looks for', () => {
  const grep = (pattern: string, root: string, glob: ReturnType<typeof some<string>> | typeof none) =>
    ruleFor({ kind: 'search', tool: 'Grep', root: root as never, pattern, glob })

  expect(grep('refreshToken', '/repo', none)).toEqual(none)
  expect(grep('password', '/repo/src/tokenizer', none)).toEqual(none)
  expect(grep('.', '/repo', some('.env'))).toEqual(some('dotenv-file'))
  expect(grep('.', '/repo', some('.env*'))).toEqual(some('dotenv-file'))
  expect(grep('KEY', '/repo', some('*.{ts,pem}'))).toEqual(some('private-key-file'))
  expect(grep('KEY', '/repo', some('**/*.ts'))).toEqual(none)
  expect(grep('KEY', '/repo/.env', none)).toEqual(some('dotenv-file'))
})

test('only source code inside the root is held to relevance', () => {
  const file = (path: string) =>
    scopeOf({ kind: 'file', tool: 'Read', path: path as never, asked: path as never }, '/repo', HOME, WORK)

  expect(file('/repo/src/billing/invoice.ts')).toEqual({ kind: 'judge' })
  expect(file('/repo/README.md')).toEqual({ kind: 'exempt', why: 'not-source' })
  expect(file('/elsewhere/lib/x.ts')).toEqual({ kind: 'exempt', why: 'outside-root' })
  expect(
    scopeOf({ kind: 'command', tool: 'Bash', command: 'cat src/billing/invoice.ts' }, '/repo', HOME, WORK),
  ).toEqual({ kind: 'judge' })
  expect(scopeOf({ kind: 'command', tool: 'Bash', command: 'npm test' }, '/repo', HOME, WORK)).toEqual({
    kind: 'exempt',
    why: 'not-source',
  })
  expect(
    scopeOf(
      { kind: 'file', tool: 'Read', path: '/repo/src/billing/invoice.ts' as never, asked: '/repo/src/billing/invoice.ts' as never },
      '/repo',
      HOME,
      { ...WORK, allowed: ['src/billing'] },
    ),
  ).toEqual({ kind: 'exempt', why: 'allow-listed' })
  expect(
    scopeOf(
      { kind: 'file', tool: 'Read', path: '/repo/a.ts' as never, asked: '/repo/a.ts' as never },
      '/repo',
      HOME,
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
  const command = { kind: 'command', tool: 'Bash', command: 'make deploy' } as const
  const kindOf = (decision: ReturnType<typeof judge>) =>
    decision.kind === 'deny' ? decision.cause.kind : decision.basis.kind
  const judged = (c: ReturnType<typeof credential>, r: readonly [number, number]) =>
    ({
      kind: 'judge',
      outcome: ok({
        ...c,
        needed_for_task: { type: 'noul' as const, noul: p(r[0]) },
        needed_for_implied_subtask: { type: 'noul' as const, noul: p(r[1]) },
      }),
    }) as const

  // Unsure is not a clear no: missing a true yes is the costly error.
  expect(kindOf(judge(DEFAULT_BAND, file, judged(credential(0.05, 0.44, 0.02), [0.9, 0.9])))).toBe('credential')
  expect(kindOf(judge(DEFAULT_BAND, file, judged(credential(0.05, 0.1, 0.02), [0.08, 0.12])))).toBe('irrelevant')
  // One clear no is not enough to block source code.
  expect(kindOf(judge(DEFAULT_BAND, file, judged(credential(0.05, 0.1, 0.02), [0.08, 0.5])))).toBe('judged')
  expect(
    kindOf(judge(DEFAULT_BAND, file, { kind: 'exempt', why: 'not-source', outcome: ok(credential(0, 0, 0)) })),
  ).toBe('exempt')
  // Jev unreachable: a file that passed the rules is read, a command is not run.
  expect(kindOf(judge(DEFAULT_BAND, file, { kind: 'judge', outcome: err({ kind: 'transport' }) }))).toBe('unjudged')
  expect(kindOf(judge(DEFAULT_BAND, command, { kind: 'judge', outcome: err({ kind: 'transport' }) }))).toBe(
    'credential',
  )
  expect(Object.keys({ ...CREDENTIAL, ...RELEVANCE }).length).toBe(5)
})

test('a routine command is blocked only on a clear yes, and runs when Jev cannot answer', () => {
  const routine = (command: string) => cautionOf({ kind: 'command', tool: 'Bash', command })

  expect(routine('git add -A && git commit -m "x" && git push origin main')).toBe('routine')
  expect(routine('ls jev; npm run lint:adt; npm test 2>&1 | tail -40')).toBe('routine')
  expect(routine("git commit -m \"$(cat <<'EOF'\nFix it\nEOF\n)\"")).toBe('routine')
  expect(routine("git commit -q -F - <<'EOF'\nFix it\nEOF")).toBe('routine')
  expect(routine('git -C /repo status && gh pr view')).toBe('routine')
  expect(routine('BRANCH=$(git branch --show-current) && git push -u origin "$BRANCH"')).toBe('routine')
  expect(routine('git push origin "$HOME"')).toBe('routine')
  expect(routine('BRANCH=$OPENROUTER_API_KEY && git push origin "$BRANCH"')).toBe('strict')
  expect(routine('git push origin "$UNSET_ELSEWHERE"')).toBe('strict')
  // Anything else, anything expanded, and git's own token printers are not.
  expect(routine('make deploy')).toBe('strict')
  expect(routine('git commit -m "$OPENROUTER_API_KEY"')).toBe('strict')
  expect(routine('git config --list')).toBe('strict')
  expect(routine('git remote -v')).toBe('strict')
  expect(routine('npm test && ./scripts/deploy.sh')).toBe('strict')
  expect(routine('tail server.log')).toBe('strict')
  expect(routine('')).toBe('strict')
  expect(cautionOf({ kind: 'file', tool: 'Read', path: '/a' as never, asked: '/a' as never })).toBe('strict')

  const npm = { kind: 'command', tool: 'Bash', command: 'npm test' } as const
  const deploy = { kind: 'command', tool: 'Bash', command: 'make deploy' } as const
  const asked = (outcome: ReturnType<typeof ok<ReturnType<typeof credential>>> | ReturnType<typeof err<JevError>>) =>
    ({ kind: 'exempt', why: 'not-source', outcome }) as const
  const kindOf = (decision: ReturnType<typeof judge>) =>
    decision.kind === 'deny' ? decision.cause.kind : decision.basis.kind

  expect(kindOf(judge(DEFAULT_BAND, npm, asked(ok(credential(0.05, 0.39, 0.02)))))).toBe('exempt')
  expect(kindOf(judge(DEFAULT_BAND, deploy, asked(ok(credential(0.05, 0.39, 0.02)))))).toBe('credential')
  expect(kindOf(judge(DEFAULT_BAND, npm, asked(ok(credential(0.05, 0.71, 0.02)))))).toBe('credential')

  const errors: readonly JevError[] = [
    { kind: 'unauthorized' },
    { kind: 'rate-limited' },
    { kind: 'overloaded' },
    { kind: 'rejected', status: 500 },
    { kind: 'transport' },
    { kind: 'malformed', at: 'answers' },
  ]

  for (const error of errors) {
    expect(kindOf(judge(DEFAULT_BAND, npm, asked(err(error))))).toBe('unjudged')
    expect(kindOf(judge(DEFAULT_BAND, deploy, asked(err(error))))).toBe('credential')
  }
})

test('a search is too wide at the root, above home, or at a top-level folder', () => {
  expect(isWideRoot('/', HOME)).toBe(true)
  expect(isWideRoot('/Users', HOME)).toBe(true)
  expect(isWideRoot('/usr', HOME)).toBe(true)
  expect(isWideRoot('/etc', none)).toBe(true)
  expect(isWideRoot('/Users/x', HOME)).toBe(false)
  expect(isWideRoot('/Users/x/code', HOME)).toBe(false)
  expect(isWideRoot('/usr/local/lib/node_modules', HOME)).toBe(false)
  // Home is never too wide, even where it is a top-level folder.
  expect(isWideRoot('/root', some('/root'))).toBe(false)
  // With no home known, only the root and top-level folders are.
  expect(isWideRoot('/Users/x', none)).toBe(false)

  const scope = (target: Parameters<typeof scopeOf>[0], home: typeof HOME | typeof none = HOME) =>
    scopeOf(target, '/Users/x/repo', home, WORK)
  const run = (command: string) => scope({ kind: 'command', tool: 'Bash', command })
  const wide = (root: string) => ({ kind: 'wide', root })

  expect(scope({ kind: 'search', tool: 'Grep', root: '/' as never, pattern: 'x', glob: none })).toEqual(wide('/'))
  expect(scope({ kind: 'search', tool: 'Glob', root: '/Users' as never, pattern: '**/*.ts' })).toEqual(wide('/Users'))
  expect(scope({ kind: 'search', tool: 'Glob', root: '/Users/x/repo' as never, pattern: '/**/*.ts' })).toEqual(wide('/'))
  expect(scope({ kind: 'search', tool: 'Grep', root: '/Users/x/repo' as never, pattern: 'x', glob: none })).toEqual({
    kind: 'exempt',
    why: 'search',
  })
  // A wide search is wide even before any task is known.
  expect(
    scopeOf({ kind: 'search', tool: 'Grep', root: '/' as never, pattern: 'x', glob: none }, '/repo', HOME, {
      ...WORK,
      prompts: [],
    }),
  ).toEqual(wide('/'))

  expect(run('find / -name "*.ts" 2>/dev/null | head')).toEqual(wide('/'))
  expect(run('grep -r foo /')).toEqual(wide('/'))
  expect(run('grep -rn foo /etc')).toEqual(wide('/etc'))
  expect(run('rg foo ~/..')).toEqual(wide('/Users'))
  expect(run('rg foo $HOME/..')).toEqual(wide('/Users'))
  expect(run('cd / && rg -l foo')).toEqual(wide('/'))
  expect(run('cd /usr && find . -name node')).toEqual(wide('/usr'))
  expect(run('ls -R /')).toEqual(wide('/'))
  expect(run('du -sh /*')).toEqual(wide('/'))
  expect(run('fd node /')).toEqual(wide('/'))
  expect(run('locate libssl')).toEqual(wide('/'))
  expect(run('mdfind kMDItemKind=App')).toEqual(wide('/'))
  // The project is never too wide, even where it is a top-level folder.
  expect(scopeOf({ kind: 'search', tool: 'Grep', root: '/app' as never, pattern: 'x', glob: none }, '/app', none, WORK)).toEqual({
    kind: 'exempt',
    why: 'search',
  })
  expect(scopeOf({ kind: 'command', tool: 'Bash', command: 'rg foo /app/src' }, '/app', none, WORK).kind).toBe('exempt')
  // Bounded: inside home, a deep system path, a search of one file, a listing.
  expect(run('find ~/code -name "*.ts"').kind).toBe('exempt')
  expect(run('find . -name "*.ts"').kind).toBe('exempt')
  expect(run('grep -rn foo /usr/local/lib/node_modules/npm').kind).toBe('exempt')
  expect(run('grep foo /etc/hosts').kind).toBe('exempt')
  expect(run('mdfind -onlyin ~/code foo').kind).toBe('exempt')
  expect(run('ls /').kind).toBe('exempt')
  expect(run('cd / && cd ~/code && rg foo').kind).toBe('exempt')
  expect(run('git commit -m "find / is blocked"').kind).toBe('exempt')
})

test('a wide search runs only when the task clearly needs the whole system', () => {
  const grep = { kind: 'search', tool: 'Grep', root: '/' as never, pattern: 'x', glob: none } as const
  const asked = (c: ReturnType<typeof credential>, needs: number) =>
    ({
      kind: 'wide',
      root: '/',
      outcome: ok({ ...c, needs_system_wide_search: { type: 'noul' as const, noul: p(needs) } }),
    }) as const
  const clean = credential(0.02, 0.02, 0.02)

  expect(judge(DEFAULT_BAND, grep, asked(clean, 0.6))).toEqual({ kind: 'allow', basis: { kind: 'system-task' } })
  expect(judge(DEFAULT_BAND, grep, asked(clean, 0.59))).toEqual({
    kind: 'deny',
    cause: { kind: 'wide-search', root: '/', why: { kind: 'jev', reading: { kind: 'unsure', p: 0.59 } } },
  })
  expect(judge(DEFAULT_BAND, grep, asked(clean, 0.1)).kind).toBe('deny')
  // A credential answer still comes first.
  const secret = judge(DEFAULT_BAND, grep, asked(credential(0.02, 0.9, 0.02), 0.95))
  expect(secret.kind === 'deny' && secret.cause.kind).toBe('credential')
  // Jev unreachable: a wide search is not run.
  const unreachable = judge(DEFAULT_BAND, grep, { kind: 'wide', root: '/', outcome: err({ kind: 'transport' }) })
  expect(unreachable).toEqual({
    kind: 'deny',
    cause: { kind: 'wide-search', root: '/', why: { kind: 'unverified', error: { kind: 'transport' } } },
  })
  expect(unreachable.kind === 'deny' && denyText(unreachable)).toContain('starts at /')
  expect(SYSTEM_BAND.yesAtLeast).toBe(0.6)
  expect(Object.keys(SYSTEM)).toEqual(['needs_system_wide_search'])
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

  const wide = {
    kind: 'deny',
    cause: { kind: 'wide-search', root: '/', why: { kind: 'unverified', error: { kind: 'transport' } } },
  } as const
  const widened = applyDecision(counted, wide)
  expect(widened.kind === 'active' && widened.blocks).toEqual({ credential: 0, irrelevant: 2, wide: 1 })
  expect(textOf(viewOf(widened))).toContain('blocked  creds 0 · off-task 2 · wide 1')
  // A count is drawn in the warning color only once something was blocked.
  const tones = Object.fromEntries(
    (rowsOf(viewOf(widened))[0] ?? []).map((segment, at, row) => [row[at - 1]?.text ?? '', segment.tone]),
  )
  expect([tones['creds '], tones['off-task '], tones['wide ']]).toEqual(['quiet', 'warn', 'warn'])
  expect(applyDecision(INITIAL, deny)).toEqual(INITIAL)
})

test('the band shows the red indicator only when dormant, the counters only when active', () => {
  const dormant = viewOf(INITIAL)
  const active = viewOf(wake(INITIAL))

  expect(rowsOf(dormant).flat().map(segment => segment.tone)).toContain('alarm')
  expect(textOf(dormant)).toBe('● OPENROUTER_API_KEY missing · JEV routing and guards are off')
  expect(rowsOf(active).flat().map(segment => segment.tone)).not.toContain('alarm')
  // Nothing spent yet: no Claude row at all, and Jev's own.
  expect(textOf(active)).toBe('● JEV  blocked  creds 0 · off-task 0 · wide 0\nJEV  0 tok $0.0000')
})

const used = (fresh: number, cacheRead: number, cacheWrite: number, output: number) =>
  usageOf({
    input_tokens: fresh,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
  })

test('a model id is priced and named whatever its spelling', () => {
  const named = (id: string) => {
    const found = priceOf(id)

    return found.kind === 'some' ? [found.value.label, found.value.price.input, found.value.price.output] : 'none'
  }

  expect(named('claude-fable-5-2')).toEqual(['Fable 5.2', 8, 40])
  expect(named('claude-mythos-5-2')).toEqual(['Mythos 5.2', 8, 40])
  expect(named('claude-fable-5-1')).toEqual(['Fable 5.1', 10, 50])
  expect(named('claude-fable-5')).toEqual(['Fable 5', 10, 50])
  expect(named('claude-opus-5-5')).toEqual(['Opus 5.5', 4, 20])
  expect(named('claude-opus-5-5[1m]')).toEqual(['Opus 5.5', 4, 20])
  expect(named('claude-opus-5')).toEqual(['Opus 5', 5, 25])
  expect(named('claude-opus-4-8')).toEqual(['Opus 4.8', 5, 25])
  expect(named('claude-opus-4-6')).toEqual(['Opus 4.6', 5, 25])
  expect(named('claude-sonnet-5-5')).toEqual(['Sonnet 5.5', 2, 10])
  expect(named('anthropic.claude-sonnet-5-5')).toEqual(['Sonnet 5.5', 2, 10])
  expect(named('claude-sonnet-5')).toEqual(['Sonnet 5', 2, 10])
  expect(named('claude-sonnet-4-6')).toEqual(['Sonnet 4.6', 3, 15])
  expect(named('claude-haiku-5-5')).toEqual(['Haiku 5.5', 0.1, 0.5])
  expect(named('claude-haiku-4-5-20251001')).toEqual(['Haiku 4.5', 1, 5])
  expect(named(TIER_MODEL.haiku)).toEqual(['Haiku 5.5', 0.1, 0.5])
  expect(named('claude-opus-3-0')).toBe('none')
  expect(named('gpt-5')).toBe('none')
})

test('input is fresh, cache-read and cache-write tokens, each at its own rate', () => {
  const line = lineOf({ model: 'claude-fable-5-2', usage: used(1000, 1_000_000, 10_000, 20_000) })

  expect(line.label).toBe('Fable 5.2')
  expect(line.input.tokens).toBe(1_011_000)
  // 1k × $8 + 1M × $0.20 + 10k × $10, per million.
  const micros = (cost: typeof line.input.cost) => (cost.kind === 'known' ? Math.round(cost.usd * 1e6) : 'unknown')
  expect(micros(line.input.cost)).toBe(308_000)
  expect(line.output.tokens).toBe(20_000)
  expect(micros(line.output.cost)).toBe(800_000)

  const unknown = lineOf({ model: 'claude-next-9', usage: used(5, 0, 0, 5) })
  expect(unknown.label).toBe('claude-next-9')
  expect(unknown.input.cost).toEqual({ kind: 'unknown' })
})

test('usage is kept per model, in the order models were first used', () => {
  const tallied = [
    ['claude-fable-5-2', used(1000, 1_000_000, 10_000, 15_000)],
    ['claude-sonnet-5-5', used(500, 0, 0, 100)],
    ['claude-fable-5-2', used(0, 0, 0, 5000)],
    ['claude-haiku-5-5', used(0, 0, 0, 0)],
  ] as const
  const active = tallied.reduce((ledger, [model, one]) => addClaude(ledger, model, one), wake(INITIAL) as Ledger)
  const dormant = tallied.reduce((ledger, [model, one]) => addClaude(ledger, model, one), INITIAL)

  expect(active.claude.map(spend => spend.model)).toEqual(['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  expect(active.claude[0]?.usage.output).toBe(20_000)

  // A model with nothing spent is not shown; each row is in, in $, out, out $,
  // its columns lined up with the other models' and its name with Jev's.
  const rows = [
    'Fable 5.2   in 1.01M   $0.31   out 20.0k $0.80',
    'Sonnet 5.5  in   500 $0.0010   out   100 $0.0010',
  ]
  expect(textOf(viewOf(active)).split('\n')).toEqual([
    '● JEV  blocked  creds 0 · off-task 0 · wide 0',
    ...rows,
    'JEV         0 tok $0.0000',
  ])
  expect(textOf(viewOf(dormant)).split('\n')).toEqual([
    '● OPENROUTER_API_KEY missing · JEV routing and guards are off',
    ...rows,
  ])
  expect(textOf(viewOf(addClaude(INITIAL, 'claude-next-9', used(10, 0, 0, 2))))).toContain(
    'claude-next-9  in 10 n/a   out 2 n/a',
  )
})
