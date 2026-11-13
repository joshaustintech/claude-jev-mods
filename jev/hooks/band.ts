// The band above the prompt, as data: a View becomes rows of toned text,
// and the render hook only maps tones to theme colors.
//
// Laid out for scanning, as the engine's own bands are: a status row first,
// then one row per Claude model with its columns lined up, then Jev. Labels
// are quiet and values plain; color is kept for what needs a look (a block
// that happened, the missing key).

import type { Blocks, Cost, Count, JevSpend, ModelLine, Tokens, View } from '../types'
import { absurd } from './domain'

/**
 * `strong` names a row; `quiet` is a label or separator; `plain` a value;
 * `good`, `warn` and `alarm` are the success, warning and error colors.
 */
export type Tone = 'plain' | 'strong' | 'quiet' | 'good' | 'warn' | 'alarm'
export type Segment = { readonly tone: Tone; readonly text: string }
export type Row = readonly Segment[]

export const formatTokens = (used: Tokens): string => {
  if (used >= 1_000_000) {
    return `${(used / 1_000_000).toFixed(2)}M`
  }

  return used >= 1000 ? `${(used / 1000).toFixed(1)}k` : `${used}`
}

const formatCost = (cost: Cost): string => {
  switch (cost.kind) {
    case 'known':
      // A cent hides a cheap model's spend: below one, show four places.
      return `$${cost.usd.toFixed(cost.usd < 0.01 ? 4 : 2)}`
    case 'unknown':
      return 'n/a'
    default:
      return absurd(cost)
  }
}

const quiet = (text: string): Segment => ({ tone: 'quiet', text })
const plain = (text: string): Segment => ({ tone: 'plain', text })

/** A count draws the eye only once something was blocked. */
const counted = (label: string, n: Count): readonly Segment[] => [
  quiet(`${label} `),
  { tone: n > 0 ? 'warn' : 'quiet', text: `${n}` },
]

const statusRow = (blocks: Blocks): Row => [
  { tone: 'good', text: '● ' },
  { tone: 'strong', text: 'JEV' },
  quiet('  blocked  '),
  ...counted('creds', blocks.credential),
  quiet(' · '),
  ...counted('off-task', blocks.irrelevant),
  quiet(' · '),
  ...counted('wide', blocks.wide),
]

const ALARM: Row = [
  { tone: 'alarm', text: '● OPENROUTER_API_KEY missing' },
  quiet(' · JEV routing and guards are off'),
]

const JEV_LABEL = 'JEV'

type Cells = {
  readonly label: string
  readonly inTokens: string
  readonly inCost: string
  readonly outTokens: string
  readonly outCost: string
}

const cellsOf = (line: ModelLine): Cells => ({
  label: line.label,
  inTokens: formatTokens(line.input.tokens),
  inCost: formatCost(line.input.cost),
  outTokens: formatTokens(line.output.tokens),
  outCost: formatCost(line.output.cost),
})

const widest = (texts: readonly string[]): number =>
  texts.reduce((most, text) => Math.max(most, text.length), 0)

/**
 * One row per model that has used tokens, its columns lined up: name, input
 * tokens and spend, output tokens and spend. `labelWidth` lines the names up
 * with the Jev row below them.
 */
const modelRows = (lines: readonly ModelLine[], labelWidth: number): readonly Row[] => {
  const cells = lines.map(cellsOf)
  const width = (pick: (one: Cells) => string): number => widest(cells.map(pick))
  const inTokens = width(one => one.inTokens)
  const inCost = width(one => one.inCost)
  const outTokens = width(one => one.outTokens)

  return cells.map(one => [
    { tone: 'strong', text: one.label.padEnd(labelWidth) },
    quiet('  in '),
    plain(one.inTokens.padStart(inTokens)),
    quiet(' '),
    plain(one.inCost.padStart(inCost)),
    quiet('   out '),
    plain(one.outTokens.padStart(outTokens)),
    quiet(' '),
    plain(one.outCost),
  ])
}

/** Jev's spend, one total: it has no output worth splitting out. */
const jevRow = (jev: JevSpend, labelWidth: number): Row => {
  const mark = jev.precision === 'estimated' ? '~' : ''

  return [
    { tone: 'strong', text: JEV_LABEL.padEnd(labelWidth) },
    quiet('  '),
    plain(`${mark}${formatTokens(jev.tokens)}`),
    quiet(' tok '),
    plain(`${mark}$${jev.usd.toFixed(4)}`),
  ]
}

/** The whole band, row by row. The red indicator exists only in the dormant view. */
export const rowsOf = (view: View): readonly Row[] => {
  switch (view.kind) {
    case 'dormant':
      return [ALARM, ...modelRows(view.claude, widest(view.claude.map(line => line.label)))]
    case 'active': {
      const labelWidth = widest([JEV_LABEL, ...view.claude.map(line => line.label)])

      return [
        statusRow(view.blocks),
        ...modelRows(view.claude, labelWidth),
        jevRow(view.jev, labelWidth),
      ]
    }
    default:
      return absurd(view)
  }
}

/** The band as plain text, a line per row: what `/jev` prints. */
export const textOf = (view: View): string =>
  rowsOf(view)
    .map(row => row.map(segment => segment.text).join(''))
    .join('\n')
