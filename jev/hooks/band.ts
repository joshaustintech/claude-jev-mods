// The band above the prompt, as data: a View becomes segments of toned text,
// and the render hook only maps tones to colors.

import type { Cost, JevSpend, Tokens, View } from '../types'
import { absurd } from './domain'

export type Tone = 'plain' | 'quiet' | 'good' | 'alarm'
export type Segment = { readonly tone: Tone; readonly text: string }

export const formatTokens = (used: Tokens): string => {
  if (used >= 1_000_000) {
    return `${(used / 1_000_000).toFixed(2)}M`
  }

  return used >= 1000 ? `${(used / 1000).toFixed(1)}k` : `${used}`
}

const formatCost = (cost: Cost): string => {
  switch (cost.kind) {
    case 'known':
      return `$${cost.usd.toFixed(2)}`
    case 'unknown':
      return 'cost n/a'
    default:
      return absurd(cost)
  }
}

const formatJev = (jev: JevSpend): string => {
  const mark = jev.precision === 'estimated' ? '~' : ''

  return `JEV ${mark}${formatTokens(jev.tokens)} tok ${mark}$${jev.usd.toFixed(4)}`
}

const claude = (used: Tokens, cost: Cost): string =>
  `Claude ${formatTokens(used)} tok ${formatCost(cost)}`

/** The whole band. The red indicator exists only in the dormant view. */
export const segmentsOf = (view: View): readonly Segment[] => {
  switch (view.kind) {
    case 'dormant':
      return [
        {
          tone: 'alarm',
          text: '● OPENROUTER_API_KEY missing: JEV routing and guards are off',
        },
        { tone: 'quiet', text: ` · ${claude(view.claude, view.cost)}` },
      ]
    case 'active':
      return [
        { tone: 'good', text: '● ' },
        { tone: 'plain', text: 'JEV' },
        {
          tone: 'quiet',
          text: ` · creds blocked ${view.blocks.credential} · irrelevant blocked ${view.blocks.irrelevant} · ${claude(view.claude, view.cost)} · ${formatJev(view.jev)}`,
        },
      ]
    default:
      return absurd(view)
  }
}

export const textOf = (view: View): string =>
  segmentsOf(view)
    .map(segment => segment.text)
    .join('')
