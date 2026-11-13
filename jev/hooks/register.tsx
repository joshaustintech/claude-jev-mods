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
  completeWithHaiku,
  homeDir,
  isGuardedTool,
  liveAgentIds,
  nonEmpty,
  optional,
  readKey,
  sessionRoot,
  spawnedAgent,
  turnUsage,
} from './boundary'
import { decide } from './decisions'
import {
  DEFAULT_BAND,
  FIRST_ROUTE,
  INITIAL,
  ROUTE_AT_LEAST,
  TIER_MODEL,
  absurd,
  addClaude,
  addJev,
  applyDecision,
  clip,
  mapResult,
  none,
  readNoul,
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
import {
  BRIEF_SYSTEM,
  ROUTE,
  SPAWN,
  briefOf,
  briefRequest,
  briefText,
  concurrencyNote,
  describeRoute,
  inFlight,
  routeOf,
  routeState,
  spawnOf,
  spawnState,
  taskOf,
  waitText,
} from './routing'

const LEDGER = atom({ plugin: 'jev', key: 'ledger' } as const, INITIAL, {
  shape: 'ledger-3',
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

const withoutSpawn = (ledger: Ledger, toolUseId: string): Ledger =>
  withWork(ledger, work => ({
    ...work,
    admitted: work.admitted.filter(one => one.toolUseId !== toolUseId),
  }))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description:
        'Show JEV routing and guard status, or allow a path past the relevance check',
      argumentHint: '[allow <path-or-glob>]',
    })
    const active = await activeOf($)
    await update($, LEDGER, ledger =>
      active.kind === 'some' ? wake(ledger) : sleep(ledger),
    )

    return next(e)
  })

  // ------------------------------------------------------------ routing

  on('prompt.submit', async ($, e, next) => {
    const active = await activeOf($)

    if (active.kind === 'none') {
      await update($, LEDGER, sleep)

      return next(e)
    }

    const isTyped =
      optional(e.command).kind === 'none' && optional(e.isMeta).kind === 'none'

    if (!isTyped) {
      await update($, LEDGER, wake)

      return next(e)
    }

    const earlier = wake(await read($, LEDGER)).work.prompts
    const outcome = await decide(
      $,
      active.value,
      routeState(e.text, earlier),
      ROUTE,
    )
    const route =
      earlier.length === 0
        ? FIRST_ROUTE
        : routeOf(
            DEFAULT_BAND,
            ROUTE_AT_LEAST,
            mapResult(outcome, decided => decided.answers),
          )
    await update($, LEDGER, ledger =>
      withWork(pay(wake(ledger), spendIn(outcome)), work => ({
        ...work,
        prompts: [...work.prompts, clip(e.text, 2000)].slice(-3),
        route,
      })),
    )

    const given = optional(e.context)
    const notes =
      outcome.kind === 'ok'
        ? [
            concurrencyNote(
              readNoul(
                DEFAULT_BAND,
                outcome.value.answers.subtasks_are_independent.noul,
              ),
            ),
          ]
        : []

    return next({
      ...e,
      context: [...(given.kind === 'some' ? given.value : []), ...notes],
    })
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const ledger = await read($, LEDGER)
    const isMainLoop = optional(e.agentId).kind === 'none'

    if (ledger.kind === 'active' && isMainLoop) {
      return yield* next({ ...e, model: ledger.work.route.tier })
    }

    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const active = await activeOf($)
    const isOrdinary =
      !e.fork &&
      optional(e.resume).kind === 'none' &&
      optional(e.workflow).kind === 'none'

    if (active.kind === 'none' || !isOrdinary) {
      return next(e)
    }

    const now = await $.clock.now()
    const live = await liveAgentIds($)
    const mine: Admitted = {
      toolUseId: e.tool_use_id,
      description: e.description,
      task: clip(e.prompt, 4000),
      at: now,
      agent: none,
    }
    // Joining the list is one atomic write, so of two spawns made together
    // exactly one sees the other ahead of it.
    const joined = await update($, LEDGER, ledger =>
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
    const ahead = wake(joined).work.admitted.filter(
      one => one.toolUseId !== mine.toolUseId,
    )
    const outcome = await decide(
      $,
      active.value,
      spawnState(e.description, e.subagentType, e.prompt, ahead),
      SPAWN,
    )
    const spawn = spawnOf(
      DEFAULT_BAND,
      ROUTE_AT_LEAST,
      nonEmpty(ahead.map(one => one.description)),
      mapResult(outcome, decided => decided.answers),
    )
    await update($, LEDGER, ledger => pay(ledger, spendIn(outcome)))

    switch (spawn.kind) {
      case 'wait':
        await update($, LEDGER, ledger => withoutSpawn(ledger, mine.toolUseId))

        return { deny: waitText(spawn.behind) }
      case 'start': {
        const written = await completeWithHaiku(
          $,
          BRIEF_SYSTEM,
          briefRequest(e.description, e.subagentType, e.prompt),
        )
        const brief = briefOf(
          written.kind === 'some' ? some(written.value.text) : none,
          e.prompt,
        )

        if (written.kind === 'some') {
          await update($, LEDGER, ledger =>
            addClaude(ledger, TIER_MODEL.haiku, written.value.used),
          )
        }

        const started = await next({
          ...e,
          model: spawn.tier,
          prompt: briefText(brief),
        })
        const agent = spawnedAgent(started)
        await update($, LEDGER, ledger =>
          agent.kind === 'some'
            ? withWork(ledger, work => ({
                ...work,
                admitted: work.admitted.map(one =>
                  one.toolUseId === mine.toolUseId ? { ...one, agent } : one,
                ),
              }))
            : withoutSpawn(ledger, mine.toolUseId),
        )

        return started
      }
      default:
        return absurd(spawn)
    }
  }).catch(($, e, next) => next(e))

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
        `Main loop route: ${describeRoute(current.work.route)}`,
        `Allowed past relevance: ${current.work.allowed.length > 0 ? current.work.allowed.join(', ') : 'nothing'}`,
      ].join('\n'),
    }
  })
}
