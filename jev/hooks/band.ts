// The band above the prompt, as data: a View becomes rows of toned text,
// and the render hook only maps tones to theme colors.
//
// Laid out for scanning, as the engine's own bands are: a status row, then a
// table of what each model has used, its columns padded to their widest cell
// so names line up on the left and the digits of each figure stack. Labels
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

/** A count draws the eye only once something was blocked. */
const counted = (label: string, n: Count): readonly Segment[] => [
  quiet(`${label} `),
  { tone: n > 0 ? 'warn' : 'quiet', text: `${n}` },
]

/** The green dot says the guards are on; Jev's own spend has a row below. */
const statusRow = (blocks: Blocks): Row => [
  { tone: 'good', text: '● ' },
  { tone: 'strong', text: 'ACTIVE' },
  quiet('  blocked  '),
  ...counted('creds', blocks.credential),
  quiet(' · '),
  ...counted('off-task', blocks.irrelevant),
  quiet(' · '),
  ...counted('wide', blocks.wide),
]

const ALARM: Row = [
  { tone: 'alarm', text: '● OPENROUTER_API_KEY missing' },
  quiet(' · JEV guards are off'),
]

// ---------------------------------------------------------------- table

/** One table row as text, before it is padded: a name, then its figures. */
type Line = {
  readonly name: string
  readonly figures: readonly string[]
}

const HEADINGS: readonly string[] = ['in', 'in $', 'out', 'out $']
const GAP = '  '

const modelLine = (line: ModelLine): Line => ({
  name: line.label,
  figures: [
    formatTokens(line.input.tokens),
    formatCost(line.input.cost),
    formatTokens(line.output.tokens),
    formatCost(line.output.cost),
  ],
})

/** Jev is one total, set in the input columns: its output costs nothing. */
const jevLine = (jev: JevSpend): Line => {
  const mark = jev.precision === 'estimated' ? '~' : ''

  return {
    name: 'JEV',
    figures: [`${mark}${formatTokens(jev.tokens)}`, `${mark}$${jev.usd.toFixed(4)}`],
  }
}

const widest = (texts: readonly string[]): number =>
  texts.reduce((most, text) => Math.max(most, text.length), 0)

/** The cell of a list at `at`, or empty where the list is shorter. */
const cellAt = (texts: readonly string[], at: number): string =>
  texts.slice(at, at + 1).join('')

/**
 * The usage table: a header, then a row per line, every column as wide as
 * its widest cell. Names line up on the left and figures on the right, so
 * the digits of each column stack. No lines, no table.
 */
const tableRows = (lines: readonly Line[]): readonly Row[] => {
  if (lines.length === 0) {
    return []
  }

  const nameWidth = widest(lines.map(line => line.name))
  // Only the columns some row fills: Jev alone has no output columns.
  const headings = HEADINGS.slice(
    0,
    lines.reduce((most, line) => Math.max(most, line.figures.length), 0),
  )
  const widths = headings.map((heading, at) =>
    widest([heading, ...lines.map(line => cellAt(line.figures, at))]),
  )
  const cells = (texts: readonly string[], tone: Tone): readonly Segment[] =>
    texts.flatMap((text, at) => [
      quiet(GAP),
      { tone, text: text.padStart(widths.slice(at, at + 1).reduce((_, w) => w, 0)) },
    ])

  return [
    [quiet(''.padEnd(nameWidth)), ...cells(headings, 'quiet')],
    ...lines.map((line): Row => [
      { tone: 'strong', text: line.name.padEnd(nameWidth) },
      ...cells(line.figures, 'plain'),
    ]),
  ]
}

/** The whole band, row by row. The red indicator exists only in the dormant view. */
export const rowsOf = (view: View): readonly Row[] => {
  switch (view.kind) {
    case 'dormant':
      return [ALARM, ...tableRows(view.claude.map(modelLine))]
    case 'active':
      return [
        statusRow(view.blocks),
        ...tableRows([...view.claude.map(modelLine), jevLine(view.jev)]),
      ]
    default:
      return absurd(view)
  }
}

/** The band as plain text, a line per row: what `/jev` prints. */
export const textOf = (view: View): string =>
  rowsOf(view)
    .map(row => row.map(segment => segment.text).join(''))
    .join('\n')
