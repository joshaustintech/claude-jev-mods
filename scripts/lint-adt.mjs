// Holds the mod to its data-model rules by reading the TypeScript syntax tree:
// outside hooks/boundary.ts (and the tests) there is no `any`, no `null`, no
// `undefined`, no cast other than `as const`, no non-null `!`, and none of
// `?.` or `??`, which are `undefined` handled out of sight. Inside
// boundary.ts only `any` is refused.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const folders = ['jev/hooks', 'jev/types']
const BOUNDARY = 'jev/hooks/boundary.ts'

const files = folders.flatMap(folder =>
  readdirSync(join(root, folder))
    .filter(name => /\.(ts|tsx)$/.test(name))
    .map(name => join(root, folder, name)),
)

const isConstCast = node =>
  ts.isAsExpression(node) &&
  ts.isTypeReferenceNode(node.type) &&
  node.type.typeName.getText() === 'const'

const findingFor = (node, isBoundary) => {
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    return '`any`'
  }

  if (isBoundary) {
    return null
  }

  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return '`null`'
  }

  if (
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  ) {
    return '`undefined`'
  }

  if (ts.isAsExpression(node) && !isConstCast(node)) {
    return 'a cast'
  }

  if (ts.isTypeAssertionExpression(node)) {
    return 'a cast'
  }

  if (ts.isNonNullExpression(node)) {
    return 'a non-null `!`'
  }

  if (node.kind === ts.SyntaxKind.QuestionDotToken) {
    return '`?.`'
  }

  if (node.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return '`??`'
  }

  if (ts.isPropertySignature(node) && node.questionToken) {
    return 'an optional property'
  }

  if (ts.isParameter(node) && node.questionToken) {
    return 'an optional parameter'
  }

  return null
}

const findings = []

for (const file of files) {
  const name = relative(root, file).split(sep).join('/')
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = node => {
    const finding = findingFor(node, name === BOUNDARY)

    if (finding !== null) {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(),
      )
      findings.push(`${name}:${line + 1}:${character + 1}  ${finding}`)
    }

    node.forEachChild(visit)
  }

  visit(source)
}

if (findings.length > 0) {
  console.error(findings.join('\n'))
  console.error(`\n${findings.length} data-model violation(s).`)
  process.exit(1)
}

console.log(`${files.length} files hold to the data-model rules.`)
