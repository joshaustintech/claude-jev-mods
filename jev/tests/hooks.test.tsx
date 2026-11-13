// The mod's hooks through the engine, with Jev, the filesystem and the
// environment answered from memory.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const KEY = { OPENROUTER_API_KEY: 'sk-or-test' }
const BAND = {
  plugin: 'jev',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

type Sent = { state: unknown; questions: Record<string, { type: string; criteria: Record<string, string> }> }
type Stage = {
  /** Jev's answer per question id: a noul's value, or the option a choice picks. */
  answers: Record<string, number | string>
  /** The HTTP status Jev answers with. */
  status: number
  sent: Sent[]
  ran: string[]
  spawned: { model: string; prompt: string }[]
  stepped: string[]
  live: string[]
  /** The session's root as the engine names it, and where a path lands, if it is a link. */
  root: string
  realOf: (path: string) => string | undefined
}

/** Stands for everything beneath the mod, and records what reached it. */
const stage = (on: On, env: Record<string, string>): Stage => {
  const it: Stage = { answers: {}, status: 200, sent: [], ran: [], spawned: [], stepped: [], live: [], root: '/repo', realOf: () => undefined }

  mock.env(on, env)
  mock.clock(on, { now: 1000 })
  on('command.register', () => ({ value: { command: 'jev' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: it.root }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1.24 } },
  }))
  on('agent.list', () => ({
    value: it.live.map(id => ({ id, description: id, type: 'general-purpose', status: 'running' as const })),
  }))
  on('fs.stat', (_, e) => {
    const realPath = it.realOf(String(e.path))

    return {
      value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, ...(realPath === undefined ? {} : { realPath }) },
    }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'Goal: do it.\nScope: here.\nConstraints: none.\nDone when: done.',
      usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('http.fetch', (_, e) => {
    const sent = JSON.parse(String(e.init?.body)) as Sent
    it.sent.push(sent)

    const answers = Object.fromEntries(
      Object.entries(sent.questions).map(([id, question]) => {
        const given = it.answers[id] ?? (question.type === 'noul' ? 0.02 : Object.keys(question.criteria)[0])

        return [
          id,
          typeof given === 'number'
            ? { type: 'noul', noul: given }
            : {
                type: 'choice',
                choice: given,
                confidence: 0.9,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map(option => [option, option === given ? 0.94 : 0.03]),
                ),
              },
        ]
      }),
    )

    return {
      value: {
        status: it.status,
        ok: it.status === 200,
        headers: {},
        text: JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 400, output_tokens: 20 } }),
      },
    }
  })
  on('tool.call', (_, e) => {
    it.ran.push(String(e.tool))

    return { result: {} }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('agent.spawn', (_, e) => {
    it.spawned.push({ model: String(e.model), prompt: e.prompt })

    return { model: String(e.model), agentId: `agent-${it.spawned.length}` }
  })
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    it.stepped.push(e.model)

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })

  return it
}

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Rename getUser to fetchUser in src/users.ts',
  description: 'Rename getUser',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

test('with no key the mod does nothing and the band says so in red', async ($, on) => {
  const it = stage(on, {})
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } })

  const read = await $.tool.call({ tool: 'Read', file_path: '/repo/.env' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'printenv' })

  expect(read.deny).toBeUndefined()
  expect(ran.deny).toBeUndefined()
  expect(it.ran).toEqual(['Read', 'Bash'])
  expect(it.sent.length).toBe(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const alarm = await ui.find({ type: 'Text', text: /OPENROUTER_API_KEY missing/ })

    expect(alarm?.text).toBe('● OPENROUTER_API_KEY missing')
    expect(alarm?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: /blocked/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('credential reads are blocked by rule, by Jev, and counted', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } })
  const asked = it.sent.length

  // Rules need no model.
  const dotenv = await $.tool.call({ tool: 'Read', file_path: '/repo/.env' })
  const dump = await $.tool.call({ tool: 'Bash', command: 'printenv | grep KEY' })
  expect(dotenv.deny).toContain('dotenv-file')
  expect(dump.deny).toContain('environment-dump')
  expect(it.sent.length).toBe(asked)

  // Past the rules, Jev is asked every question in one request.
  it.answers = { reads_secret_store: 0.91 }
  const config = await $.tool.call({ tool: 'Read', file_path: '/repo/config/prod.yaml' })
  expect(config.deny).toContain('reads_secret_store at 0.91')
  expect(it.sent.length).toBe(asked + 1)
  expect(Object.keys(it.sent.at(-1)?.questions ?? {})).toEqual([
    'reveals_env_values',
    'reads_secret_store',
    'prints_or_sends_token',
  ])

  // Unsure is not a clear no.
  it.answers = { prints_or_sends_token: 0.5 }
  const unsure = await $.tool.call({ tool: 'Bash', command: './scripts/deploy.sh --show' })
  expect(unsure.deny).toContain('prints_or_sends_token')

  it.answers = {}
  const fine = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(fine.deny).toBeUndefined()
  expect(it.ran).toEqual(['Bash'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const count = await ui.find({ type: 'Text', text: '4' })
  expect(count?.props.color).toBe('warning')
  expect(await ui.find({ type: 'Text', text: /missing/ })).toBeUndefined()
  await ui.unmount()
})

test('a file filter, a list of paths and a watched command are all guarded', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } })

  // What a search looks for is free; the files it is narrowed to are not.
  const term = await $.tool.call({ tool: 'Grep', pattern: 'refreshToken' } as never)
  const filtered = await $.tool.call({ tool: 'Grep', pattern: '.', glob: '.env' } as never)
  expect(term.deny).toBeUndefined()
  expect(filtered.deny).toContain('dotenv-file')

  const several = await $.tool.call({
    tool: 'mcp__filesystem__read_multiple_files',
    paths: ['/repo/README.md', '/repo/.env'],
  } as never)
  expect(several.deny).toContain('dotenv-file')

  const watched = await $.tool.call({ tool: 'Monitor', description: 'env', timeout_ms: 1000, command: 'printenv' } as never)
  expect(watched.deny).toContain('environment-dump')
  expect(it.ran).toEqual(['Grep'])
})

test('a root reached through a link still holds its files to relevance', async ($, on) => {
  const it = stage(on, KEY)
  it.root = '/link'
  it.realOf = path => path.replace(/^\/link/, '/repo')
  await $.session.start({ cwd: '/link', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login redirect bug', wait: false, origin: { kind: 'composer' } })

  it.answers = { needed_for_task: 0.04, needed_for_implied_subtask: 0.1 }
  const billing = await $.tool.call({ tool: 'Read', file_path: '/link/src/billing/invoice.ts' })
  expect(billing.deny).toContain('unrelated to the task')
})

test('source code off the task is blocked only on two clear nos', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login redirect bug', wait: false, origin: { kind: 'composer' } })

  it.answers = { needed_for_task: 0.9, needed_for_implied_subtask: 0.8 }
  const login = await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts' })
  expect(login.deny).toBeUndefined()
  expect(Object.keys(it.sent.at(-1)?.questions ?? {}).length).toBe(5)

  it.answers = { needed_for_task: 0.04, needed_for_implied_subtask: 0.1 }
  const billing = await $.tool.call({ tool: 'Read', file_path: '/repo/src/billing/invoice.ts' })
  expect(billing.deny).toContain('unrelated to the task')
  // The state carries the task and the call, and what was read before it.
  expect(it.sent.at(-1)?.state).toMatchObject({
    task: { requests: ['Fix the login redirect bug'] },
    call: { tool: 'Read', path: '/repo/src/billing/invoice.ts' },
    already_read: ['/repo/src/auth/login.ts'],
  })

  it.answers = { needed_for_task: 0.04, needed_for_implied_subtask: 0.5 }
  const shared = await $.tool.call({ tool: 'Read', file_path: '/repo/src/shared/http.ts' })
  expect(shared.deny).toBeUndefined()

  // Docs are never held to relevance.
  it.answers = { needed_for_task: 0, needed_for_implied_subtask: 0 }
  const readme = await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
  expect(readme.deny).toBeUndefined()

  // /jev allow lifts the check for a path.
  await $.command.run({ command: 'jev', args: 'allow src/billing', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const allowed = await $.tool.call({ tool: 'Read', file_path: '/repo/src/billing/invoice.ts' })
  expect(allowed.deny).toBeUndefined()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text).toContain(
    'blocked  creds 0 · off-task 1 · wide 0',
  )
  await ui.unmount()
})

test('when Jev cannot answer, a file is read, a routine command runs and others do not', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } })
  it.status = 401

  const file = await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts' })
  const routine = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const command = await $.tool.call({ tool: 'Bash', command: 'make deploy' })
  const wide = await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/' } as never)

  expect(file.deny).toBeUndefined()
  expect(routine.deny).toBeUndefined()
  expect(command.deny).toContain('OpenRouter refused the API key')
  expect(wide.deny).toContain('starts at /')
  expect(it.ran).toEqual(['Read', 'Bash'])
})

test('routine commands are blocked only on a clear yes; commits with heredocs run', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Commit and push', wait: false, origin: { kind: 'composer' } })

  // The answer that once blocked `npm test`.
  it.answers = { reads_secret_store: 0.39 }
  const tests = await $.tool.call({ tool: 'Bash', command: 'ls jev; npm run lint:adt; npm test' })
  const commit = await $.tool.call({
    tool: 'Bash',
    command: "git add -A && git commit -q -F - <<'EOF'\nGuard .env reads; process.env and printenv\nEOF\ngit push",
  })
  const deploy = await $.tool.call({ tool: 'Bash', command: 'make deploy' })

  expect(tests.deny).toBeUndefined()
  expect(commit.deny).toBeUndefined()
  expect(deploy.deny).toContain('reads_secret_store at 0.39')

  it.answers = { reads_secret_store: 0.9 }
  const clear = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(clear.deny).toContain('reads_secret_store at 0.90')
})

test('a search from a too-wide folder runs only when the task needs the whole system', async ($, on) => {
  const it = stage(on, { ...KEY, HOME: '/Users/x' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } })

  it.answers = { needs_system_wide_search: 0.3 }
  const grep = await $.tool.call({ tool: 'Grep', pattern: 'login', path: '/' } as never)
  const find = await $.tool.call({ tool: 'Bash', command: 'find /Users -name "*.ts" 2>/dev/null' })
  expect(grep.deny).toContain('starts at /,')
  expect(find.deny).toContain('starts at /Users,')
  // Credentials and the system need are asked in one request.
  expect(Object.keys(it.sent.at(-1)?.questions ?? {})).toEqual([
    'reveals_env_values',
    'reads_secret_store',
    'prints_or_sends_token',
    'needs_system_wide_search',
  ])

  // Searching the project or home is not wide, and asks nothing about it.
  const home = await $.tool.call({ tool: 'Bash', command: 'rg login ~/code' })
  expect(home.deny).toBeUndefined()
  expect(Object.keys(it.sent.at(-1)?.questions ?? {})).not.toContain('needs_system_wide_search')

  it.answers = { needs_system_wide_search: 0.8 }
  const asked = await $.tool.call({ tool: 'Grep', pattern: 'libssl', path: '/' } as never)
  expect(asked.deny).toBeUndefined()

  const status = await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(status.text).toContain('wide 2')
})

test('with no key a wide search passes untouched and silently', async ($, on) => {
  const it = stage(on, { HOME: '/Users/x' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const grep = await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/' } as never)
  const find = await $.tool.call({ tool: 'Bash', command: 'find / -name x' })

  expect(grep.deny).toBeUndefined()
  expect(find.deny).toBeUndefined()
  expect(it.sent.length).toBe(0)
})

test('prompts are routed: Opus first, then by Jev, with a note on subagent order', async ($, on) => {
  const it = stage(on, KEY)
  const status = async () =>
    (await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  it.answers = { work: 'defined_task', fits_a_work_kind: 0.97, subtasks_are_independent: 0.9 }
  const first = await $.prompt.submit({ text: 'Rename a variable', wait: false, origin: { kind: 'composer' } })
  expect(await status()).toContain('Main loop route: opus (first turn plans on Opus)')
  expect(first.context?.join(' ')).toContain('launch them in parallel')

  it.answers = { work: 'medium_coding', fits_a_work_kind: 0.97, subtasks_are_independent: 0.1 }
  const second = await $.prompt.submit({ text: 'Add pagination to the users endpoint', wait: false, origin: { kind: 'composer' } })
  expect(await status()).toContain('Main loop route: sonnet (Jev: medium_coding at 0.94)')
  expect(second.context?.join(' ')).toContain('one at a time')

  it.answers = { work: 'defined_task', fits_a_work_kind: 0.2 }
  await $.prompt.submit({ text: 'hmm', wait: false, origin: { kind: 'composer' } })
  expect(await status()).toContain('Main loop route: opus (fallback: no-fit)')
})

test('each main-loop step runs on the routed tier; a subagent step is left alone', async ($, on) => {
  const it = stage(on, KEY)
  const step = async (agentId?: string) => {
    const stream = $.turn.step({
      turnId: 't1',
      index: 0,
      model: 'claude-fable-5-2',
      messageCount: 1,
      ...(agentId ? { agentId } : {}),
    })

    for await (const chunk of stream) {
      void chunk
    }
  }
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Plan the migration', wait: false, origin: { kind: 'composer' } })
  await step()

  it.answers = { work: 'medium_coding', fits_a_work_kind: 0.97 }
  await $.prompt.submit({ text: 'Add pagination to the users endpoint', wait: false, origin: { kind: 'composer' } })
  await step()
  await step('agent-1')

  expect(it.stepped).toEqual(['opus', 'sonnet', 'claude-fable-5-2'])
})

test('with no key a step keeps its model, and Claude tokens are still tallied', async ($, on) => {
  const it = stage(on, {})
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-2', messageCount: 1 })) {
    void chunk
  }

  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-fable-5-2',
      input_tokens: 900,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })

  expect(it.stepped).toEqual(['claude-fable-5-2'])
  expect(it.sent.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Fable/ }))?.text).toBe('Fable 5.2')
  expect((await ui.find({ type: 'Text', text: '$0.0072' }))?.text).toBe('$0.0072')
  await ui.unmount()
})

const finished = (turnId: string, model: string, input: number, output: number, agentId?: string) => ({
  answer: 'done',
  durationMs: 10,
  isAborted: false,
  turnId,
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
  usage: { model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

test('Claude usage is shown per model, in then out, and unused models are not', async ($, on) => {
  stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const before = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await before.find({ type: 'Text', text: /Fable|Sonnet/ })).toBeUndefined()
  expect((await before.find({ type: 'Text', text: 'ACTIVE' }))?.props.weight).toBe('semibold')
  await before.unmount()

  await $.turn.complete(finished('t1', 'claude-fable-5-2', 2000, 1000))
  await $.turn.complete(finished('t2', 'claude-sonnet-5-5', 3000, 500, 'agent-1'))
  await $.turn.complete(finished('t3', 'claude-haiku-5-5', 0, 0, 'agent-2'))
  await $.turn.complete(finished('t4', 'claude-fable-5-2', 0, 250))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Fable/ }))?.props.weight).toBe('semibold')
  expect(await ui.find({ type: 'Text', text: /Haiku/ })).toBeUndefined()
  await ui.unmount()

  const status = await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect((status.text ?? "").split('\n').slice(1, 5)).toEqual([
    '              in     in $   out    out $',
    'Fable 5.2   2.0k    $0.02  1.3k    $0.05',
    'Sonnet 5.5  3.0k  $0.0060   500  $0.0050',
    'JEV            0  $0.0000',
  ])
})

test('a commit whose message names env reads and secret files is not blocked', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Commit and push the guard fix', wait: false, origin: { kind: 'composer' } })

  const commit = await $.tool.call({
    tool: 'Bash',
    command: `git commit -m "$(cat <<'EOF'\nStop reading process.env; block .env and secrets.json\nEOF\n)" && git push`,
  })

  expect(commit.deny).toBeUndefined()
  expect(it.ran).toEqual(['Bash'])
  // Jev still judges the whole command, message included.
  expect(JSON.stringify(it.sent.at(-1)?.state)).toContain('process.env')
})

test('subagents get a tier and a Haiku brief, and wait when they depend on running work', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  it.answers = { work: 'defined_task', fits_a_work_kind: 0.97 }
  const first = await $.agent.spawn(SPAWN)
  expect(first.deny).toBeUndefined()
  expect(it.spawned[0]?.model).toBe('haiku')
  expect(it.spawned[0]?.prompt).toContain('Goal: do it.')
  expect(it.spawned[0]?.prompt).toContain(SPAWN.prompt)

  // The first is still running; the second depends on it.
  it.live = ['agent-1']
  it.answers = { work: 'medium_coding', fits_a_work_kind: 0.97, independent_of_running: 0.1 }
  const second = await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'Update callers' })
  expect(second.deny).toContain('Rename getUser')
  expect(it.spawned.length).toBe(1)

  // Independent work starts beside it, on Sonnet.
  it.answers = { work: 'medium_coding', fits_a_work_kind: 0.97, independent_of_running: 0.95 }
  const third = await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_3', description: 'Write docs' })
  expect(third.deny).toBeUndefined()
  expect(it.spawned[1]?.model).toBe('sonnet')

  // Each Haiku brief (50 in, 20 out) is Claude spend, filed under Haiku.
  const status = await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(status.text).toContain('Haiku 5.5   100  $0.0000   40  $0.0000')
})
