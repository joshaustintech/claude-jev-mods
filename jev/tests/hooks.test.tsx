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
}

/** Stands for everything beneath the mod, and records what reached it. */
const stage = (on: On, env: Record<string, string>): Stage => {
  const it: Stage = { answers: {}, status: 200, sent: [], ran: [], spawned: [], stepped: [], live: [] }

  mock.env(on, env)
  mock.clock(on, { now: 1000 })
  on('command.register', () => ({ value: { command: 'jev' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1.24 } },
  }))
  on('agent.list', () => ({
    value: it.live.map(id => ({ id, description: id, type: 'general-purpose', status: 'running' as const })),
  }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
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

    expect(alarm?.text).toBe('● OPENROUTER_API_KEY missing: JEV routing and guards are off')
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
  expect((await ui.find({ type: 'Text', text: /creds blocked/ }))?.text).toContain('creds blocked 4 · irrelevant blocked 0')
  expect(await ui.find({ type: 'Text', text: /missing/ })).toBeUndefined()
  await ui.unmount()
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
  expect((await ui.find({ type: 'Text', text: /irrelevant blocked/ }))?.text).toContain('creds blocked 0 · irrelevant blocked 1')
  await ui.unmount()
})

test('when Jev cannot answer, a file is read and a command is not run', async ($, on) => {
  const it = stage(on, KEY)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } })
  it.status = 401

  const file = await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts' })
  const command = await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(file.deny).toBeUndefined()
  expect(command.deny).toContain('OpenRouter refused the API key')
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
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Claude/ }))?.text).toBe(' · Claude 1.2k tok $1.24')
  await ui.unmount()
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
})
