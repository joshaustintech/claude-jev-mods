// Wiring only: each engine event is turned into the data model, judged by a
// pure function, and answered. With no OpenRouter key every hook here passes
// its event on untouched and says nothing.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Active,
  Actor,
  Admitted,
  Decision,
  JevError,
  JevSpend,
  Json,
  Ledger,
  Option,
  Result,
  Scope,
  Target,
  Usage,
} from '../types'
import { rowsOf, textOf } from './band'
import type { Row, Segment } from './band'
import {
  classify,
  homeDir,
  isGuardedTool,
  liveAgentIds,
  optional,
  readKey,
  sessionRoot,
  spawnedAgent,
  turnUsage,
} from './boundary'
import { decide } from './decisions'
import {
  DEFAULT_BAND,
  INITIAL,
  absurd,
  addClaude,
  addJev,
  applyDecision,
  clip,
  mapResult,
  none,
  remember,
  sleep,
  some,
  spendOf,
  viewOf,
  wake,
  withWork,
} from './domain'
import {
  CREDENTIAL,
  RELEVANCE,
  SYSTEM,
  denyText,
  guardState,
  judge,
  ruleForAll,
  scopeOf,
} from './guard'
import { inFlight, taskOf } from './agents'

const LEDGER = atom({ plugin: 'jev', key: 'ledger' } as const, INITIAL, {
  shape: 'ledger-4',
})

/** The key, or nothing: the one test of whether the mod does anything. */
async function activeOf($: EngineInterface): Promise<Option<Active>> {
  const key = await readKey($)

  return key.kind === 'some' ? some({ key: key.value }) : none
}

const spendIn = (
  outcome: Result<{ readonly usage: Usage }, JevError>,
): Option<JevSpend> =>
  outcome.kind === 'ok' ? some(spendOf(outcome.value.usage)) : none

const pay = (ledger: Ledger, spend: Option<JevSpend>): Ledger =>
  spend.kind === 'some' ? addJev(ledger, spend.value) : ledger

type Verdict = { readonly decision: Decision; readonly spend: Option<JevSpend> }

/** One Jev request per guarded call: every question it needs, asked together. */
async function verdictOf(
  $: EngineInterface,
  active: Active,
  target: Target,
  scope: Scope,
  state: Json,
): Promise<Verdict> {
  switch (scope.kind) {
    case 'judge': {
      const outcome = await decide($, active, state, {
        ...CREDENTIAL,
        ...RELEVANCE,
      })

      return {
        decision: judge(DEFAULT_BAND, target, {
          kind: 'judge',
          outcome: mapResult(outcome, decided => decided.answers),
        }),
        spend: spendIn(outcome),
      }
    }
    case 'exempt': {
      const outcome = await decide($, active, state, CREDENTIAL)

      return {
        decision: judge(DEFAULT_BAND, target, {
          kind: 'exempt',
          why: scope.why,
          outcome: mapResult(outcome, decided => decided.answers),
        }),
        spend: spendIn(outcome),
      }
    }
    case 'wide': {
      const outcome = await decide($, active, state, {
        ...CREDENTIAL,
        ...SYSTEM,
      })

      return {
        decision: judge(DEFAULT_BAND, target, {
          kind: 'wide',
          root: scope.root,
          outcome: mapResult(outcome, decided => decided.answers),
        }),
        spend: spendIn(outcome),
      }
    }
    default:
      return absurd(scope)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description:
        'Show JEV guard status, or allow a path past the relevance check',
      argumentHint: '[allow <path-or-glob>]',
    })
    const active = await activeOf($)
    await update($, LEDGER, ledger =>
      active.kind === 'some' ? wake(ledger) : sleep(ledger),
    )

    return next(e)
  })

  // ------------------------------------------------------------ work
  // The prompts and subagent tasks are kept only as context for the
  // relevance check. The model, the prompt and the order of subagents are
  // the user's and the engine's: they pass on as they came.

  on('prompt.submit', async ($, e, next) => {
    const active = await activeOf($)

    if (active.kind === 'none') {
      await update($, LEDGER, sleep)

      return next(e)
    }

    const isTyped =
      optional(e.command).kind === 'none' && optional(e.isMeta).kind === 'none'
    await update($, LEDGER, ledger =>
      isTyped
        ? withWork(wake(ledger), work => ({
            ...work,
            prompts: [...work.prompts, clip(e.text, 2000)].slice(-3),
          }))
        : wake(ledger),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agent = spawnedAgent(started)

    if (agent.kind === 'none' || (await activeOf($)).kind === 'none') {
      return started
    }

    // The spawn has happened: keeping its task can only fail quietly.
    const keep = async (agentId: string) => {
      const now = await $.clock.now()
      const live = [...(await liveAgentIds($)), agentId]
      const mine: Admitted = {
        toolUseId: e.tool_use_id,
        description: e.description,
        task: clip(e.prompt, 4000),
        at: now,
        agent: some(agentId),
      }
      await update($, LEDGER, ledger =>
        withWork(wake(ledger), work => ({
          ...work,
          admitted: [
            ...inFlight(work.admitted, live, now).filter(
              one => one.toolUseId !== mine.toolUseId,
            ),
            mine,
          ],
        })),
      )
    }

    return keep(agent.value).then(
      () => started,
      () => started,
    )
  })

  // ------------------------------------------------------------ guard

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)

    if (!isGuardedTool(tool)) {
      return next(e)
    }

    const active = await activeOf($)

    if (active.kind === 'none') {
      return next(e)
    }

    const agent = optional(e.agentId)
    const actor: Actor =
      agent.kind === 'some'
        ? { kind: 'subagent', agentId: agent.value }
        : { kind: 'main' }
    const intent = await classify($, await $.session.cwd(), tool, e, actor)

    if (intent.kind === 'other') {
      return next(e)
    }

    const { target, more } = intent
    const rule = ruleForAll([target, ...more])
    const work = wake(await read($, LEDGER)).work
    const verdict: Verdict =
      rule.kind === 'some'
        ? {
            decision: {
              kind: 'deny',
              cause: {
                kind: 'credential',
                evidence: { kind: 'rule', rule: rule.value },
              },
            },
            spend: none,
          }
        : await verdictOf(
            $,
            active.value,
            target,
            scopeOf(target, await sessionRoot($), await homeDir($), work),
            guardState(
              target,
              more,
              work,
              actor.kind === 'subagent'
                ? taskOf(work.admitted, actor.agentId)
                : none,
            ),
          )
    const { decision } = verdict
    await update($, LEDGER, ledger => {
      const counted = pay(applyDecision(wake(ledger), decision), verdict.spend)

      return decision.kind === 'allow' && target.kind === 'file'
        ? withWork(counted, known => ({
            ...known,
            read: remember(known.read, target.path, 30),
          }))
        : counted
    })

    switch (decision.kind) {
      case 'deny':
        return { deny: denyText(decision) }
      case 'allow':
        return next(e)
      default:
        return absurd(decision)
    }
  }).catch(async ($, e, next) => {
    // A guard that failed must not wave a read through while the key is set.
    if (next.called || !isGuardedTool(String(e.tool))) {
      return next(e)
    }

    const active = await activeOf($)

    return active.kind === 'some'
      ? { deny: 'jev: its guard failed, so this call is blocked.' }
      : next(e)
  })

  // ------------------------------------------------------------ display

  on('turn.complete', async ($, e, next) => {
    const turn = turnUsage(e.usage)

    if (turn.kind === 'some') {
      const { model, used } = turn.value
      await update($, LEDGER, ledger => addClaude(ledger, model, used))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const active = await activeOf($)
    const ledger = await read($, LEDGER)
    const view = viewOf(active.kind === 'some' ? wake(ledger) : sleep(ledger))
    // Theme keys only, so the band follows the person's theme. Every cell is
    // mono with tabular digits, so the table's columns line up on every surface.
    const draw = (segment: Segment) => {
      switch (segment.tone) {
        case 'alarm':
          return (
            <Text mono tabular color="error" weight="semibold">
              {segment.text}
            </Text>
          )
        case 'warn':
          return (
            <Text mono tabular color="warning" weight="semibold">
              {segment.text}
            </Text>
          )
        case 'good':
          return <Text mono tabular color="success">{segment.text}</Text>
        case 'strong':
          return <Text mono tabular weight="semibold">{segment.text}</Text>
        case 'quiet':
          return <Text mono tabular color="subtle">{segment.text}</Text>
        case 'plain':
          return <Text mono tabular>{segment.text}</Text>
        default:
          return absurd(segment.tone)
      }
    }
    // A row wraps at the band's width rather than running under its marks.
    const line = (row: Row) => <Box flexWrap="wrap">{row.map(draw)}</Box>

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {rowsOf(view).map(line)}
      </Box>
    )
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const active = await activeOf($)
    const ledger = await read($, LEDGER)

    if (active.kind === 'none') {
      return { text: textOf(viewOf(sleep(ledger))) }
    }

    const args = e.args.trim()
    const entry = args.startsWith('allow ') ? args.slice(6).trim() : ''

    if (entry.length > 0) {
      await update($, LEDGER, current =>
        withWork(wake(current), work => ({
          ...work,
          allowed: remember(work.allowed, entry, 100),
        })),
      )

      return {
        text: `jev: ${entry} is past the relevance check for this session. The credential rules still apply to it.`,
      }
    }

    if (args.length > 0) {
      return { text: 'Usage: /jev, or /jev allow <path-or-glob>' }
    }

    const current = wake(ledger)

    return {
      text: [
        textOf(viewOf(current)),
        `Allowed past relevance: ${current.work.allowed.length > 0 ? current.work.allowed.join(', ') : 'nothing'}`,
      ].join('\n'),
    }
  })
}
