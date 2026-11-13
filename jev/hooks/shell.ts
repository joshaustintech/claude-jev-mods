// A shell command as the shell would split it: quotes respected, each
// substitution a command of its own, each heredoc body kept with the command
// that reads it. Pure, and never runs anything: it only says what would run.

import type { Heredoc, Option, Segment, Word } from '../types'
import { none, some } from './domain'

type Kind = Word['kind']

const RANK: Readonly<Record<Kind, number>> = {
  literal: 0,
  substituting: 1,
  expanding: 2,
}

const stronger = (a: Kind, b: Kind): Kind => (RANK[a] >= RANK[b] ? a : b)

/** What stands in a word's text for a substitution's output. */
const SUBSTITUTED = '$()'

const NAME_START = /[A-Za-z_{]/

type Quoted = {
  readonly text: string
  readonly kind: Kind
  readonly segments: readonly Segment[]
  readonly end: number
}

type Until = 'end' | 'paren' | 'backtick'
type Lexed = { readonly segments: readonly Segment[]; readonly end: number }

type Draft = {
  readonly words: readonly Word[]
  /** Which of this level's heredoc bodies the command reads. */
  readonly heredocAt: Option<number>
  readonly joined: 'pipe' | 'other'
}

type Pending = { readonly delimiter: string; readonly isQuoted: boolean }

/**
 * Text as double quotes hold it, from `from` to the closing quote, or to the
 * end of the text for a heredoc body (`closes` false). Only substitutions and
 * `$NAME` mean anything here.
 */
function quoted(text: string, from: number, closes: boolean): Quoted {
  const segments: Segment[] = []
  let out = ''
  let kind: Kind = 'literal'
  let i = from

  while (i < text.length) {
    const c = text.charAt(i)
    const next = text.charAt(i + 1)

    if (closes && c === '"') {
      return { text: out, kind, segments, end: i + 1 }
    }

    if (c === '\\' && next !== '') {
      out += '"\\$`'.includes(next) ? next : next === '\n' ? '' : `\\${next}`
      i += 2
    } else if (c === '`' || (c === '$' && next === '(')) {
      const inner = c === '`' ? lex(text, i + 1, 'backtick') : lex(text, i + 2, 'paren')

      segments.push(...inner.segments)
      out += SUBSTITUTED
      kind = stronger(kind, 'substituting')
      i = inner.end
    } else {
      if (c === '$' && NAME_START.test(next)) {
        kind = 'expanding'
      }

      out += c
      i += 1
    }
  }

  return { text: out, kind, segments, end: text.length }
}

const heredocOf = (pending: Pending, body: string): Quoted & { readonly heredoc: Heredoc } => {
  const read = quoted(body, 0, false)

  return {
    ...read,
    heredoc: {
      kind: pending.isQuoted || read.kind === 'literal' ? 'literal' : 'expanding',
      body,
    },
  }
}

function lex(text: string, from: number, until: Until): Lexed {
  const drafts: Draft[] = []
  const nested: Segment[] = []
  const bodies: Heredoc[] = []
  let pending: readonly Pending[] = []
  let words: readonly Word[] = []
  let heredocAt: Option<number> = none
  let buffer = ''
  let kind: Kind = 'literal'
  let isStarted = false
  let depth = 0
  let i = from

  const endWord = (): void => {
    if (isStarted) {
      words = [...words, { kind, text: buffer }]
    }

    buffer = ''
    kind = 'literal'
    isStarted = false
  }

  const endSegment = (joined: Draft['joined']): void => {
    endWord()

    if (words.length > 0) {
      drafts.push({ words, heredocAt, joined })
    }

    words = []
    heredocAt = none
  }

  const substitute = (inner: Lexed): void => {
    nested.push(...inner.segments)
    buffer += SUBSTITUTED
    kind = stronger(kind, 'substituting')
    isStarted = true
    i = inner.end
  }

  /** The bodies of the heredocs opened on the line that just ended. */
  const readBodies = (): void => {
    for (const one of pending) {
      const lines: string[] = []
      let isOpen = true

      while (isOpen && i < text.length) {
        const stop = text.indexOf('\n', i)
        const lineEnd = stop < 0 ? text.length : stop
        const line = text.slice(i, lineEnd)

        i = Math.min(lineEnd + 1, text.length)

        if (line.trim() === one.delimiter) {
          isOpen = false
        } else {
          lines.push(line)
        }
      }

      const read = heredocOf(one, lines.join('\n'))

      bodies.push(read.heredoc)

      if (!one.isQuoted) {
        nested.push(...read.segments)
      }
    }

    pending = []
  }

  const finish = (end: number): Lexed => {
    endSegment('other')

    const own = drafts.flatMap((draft, at): readonly Segment[] =>
      draft.words.slice(0, 1).map(first => ({
        words: [first, ...draft.words.slice(1)] as const,
        heredoc:
          draft.heredocAt.kind === 'some'
            ? bodies
                .slice(draft.heredocAt.value, draft.heredocAt.value + 1)
                .reduce<Option<Heredoc>>((_, body) => some(body), none)
            : none,
        pipedInto:
          draft.joined === 'pipe'
            ? drafts
                .slice(at + 1, at + 2)
                .flatMap(following => following.words.slice(0, 1))
                .reduce<Option<string>>((_, word) => some(word.text), none)
            : none,
      })),
    )

    return { segments: [...own, ...nested], end }
  }

  while (i < text.length) {
    const c = text.charAt(i)
    const next = text.charAt(i + 1)

    if (until === 'paren' && c === ')' && depth === 0) {
      return finish(i + 1)
    }

    if (until === 'backtick' && c === '`') {
      return finish(i + 1)
    }

    if (c === '\\') {
      if (next !== '\n') {
        buffer += next
        isStarted = true
      }

      i += 2
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      const stop = close < 0 ? text.length : close

      buffer += text.slice(i + 1, stop)
      isStarted = true
      i = stop + 1
    } else if (c === '"') {
      const inner = quoted(text, i + 1, true)

      nested.push(...inner.segments)
      buffer += inner.text
      kind = stronger(kind, inner.kind)
      isStarted = true
      i = inner.end
    } else if (c === '`') {
      substitute(lex(text, i + 1, 'backtick'))
    } else if (c === '$' && next === '(') {
      substitute(lex(text, i + 2, 'paren'))
    } else if (c === '$') {
      if (NAME_START.test(next)) {
        kind = 'expanding'
      }

      buffer += c
      isStarted = true
      i += 1
    } else if (c === '#' && !isStarted) {
      const stop = text.indexOf('\n', i)

      i = stop < 0 ? text.length : stop
    } else if (c === '\n') {
      endSegment('other')
      i += 1
      readBodies()
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i += 1
    } else if (c === ';') {
      endSegment('other')
      i += 1
    } else if (c === '&') {
      if (next === '&') {
        endSegment('other')
        i += 2
      } else if (buffer.endsWith('>') || next === '>') {
        // `2>&1` and `&>file` are redirections, not the end of a command.
        buffer += c
        isStarted = true
        i += 1
      } else {
        endSegment('other')
        i += 1
      }
    } else if (c === '|') {
      endSegment(next === '|' ? 'other' : 'pipe')
      i += next === '|' ? 2 : 1
    } else if (c === '(' || c === ')') {
      depth = Math.max(0, depth + (c === '(' ? 1 : -1))
      endSegment('other')
      i += 1
    } else if (c === '<' && next === '<' && text.charAt(i + 2) === '<') {
      buffer += '<<<'
      isStarted = true
      i += 3
    } else if (c === '<' && next === '<') {
      const [[whole = '', raw = ''] = []] = [
        ...text.slice(i).matchAll(/^<<-?[ \t]*([^\s;|&()<>]+)/g),
      ]
      const delimiter = raw.replace(/['"\\]/g, '')

      if (delimiter.length === 0) {
        buffer += '<<'
        isStarted = true
        i += 2
      } else {
        endWord()
        heredocAt = some(bodies.length + pending.length)
        pending = [...pending, { delimiter, isQuoted: delimiter !== raw }]
        i += whole.length
      }
    } else {
      buffer += c
      isStarted = true
      i += 1
    }
  }

  return finish(text.length)
}

/**
 * Every simple command a command line would run, the ones inside `$(...)`,
 * backticks and expanding heredocs included, after the ones that hold them.
 */
export const segmentsOf = (command: string): readonly Segment[] =>
  lex(command, 0, 'end').segments
