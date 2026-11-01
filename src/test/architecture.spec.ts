import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(directory: string, includeVue = false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(file, includeVue)
    return (entry.name.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(entry.name))
      || (includeVue && entry.name.endsWith('.vue')) ? [file] : []
  })
}

function dependencies(file: string, runtimeOnly = false): string[] {
  const content = readFileSync(file, 'utf8')
  const script = file.endsWith('.vue')
    ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
    : content
  const source = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true)
  const result = new Set<string>()
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const typeOnly = clause?.isTypeOnly || (!clause?.name && named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly))
      if (!runtimeOnly || !typeOnly) result.add(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause
      const typeOnly = node.isTypeOnly || (named && ts.isNamedExports(named)
        && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly))
      if (!runtimeOnly || !typeOnly) result.add(node.moduleSpecifier.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      if (!runtimeOnly) result.add(node.argument.literal.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...result]
}

it.each([
  { name: 'domain, rules and engine', folders: ['domain', 'rules', 'engine'], forbidden: ['components', 'workbench', 'optimizer'] },
  { name: 'scheduler', folders: ['scheduler'], forbidden: ['components', 'workbench', 'optimizer'] },
  { name: 'simulator', folders: ['simulator'], forbidden: ['components', 'optimizer'] },
])('keeps $name independent of higher-level modules', ({ folders, forbidden }) => {
  const violations: string[] = []
  for (const file of folders.flatMap(folder => sourceFiles(resolve(sourceRoot, folder)))) {
    for (const dependency of dependencies(file)) {
      const layer = dependency.startsWith('.') ? relative(sourceRoot, resolve(dirname(file), dependency)).split(sep)[0] : dependency
      if (forbidden.includes(layer!) || ['vue', 'pinia'].includes(dependency)) {
        violations.push(`${relative(sourceRoot, file)} imports ${dependency}`)
      }
    }
  }
  expect(violations).toEqual([])
})

it('keeps runtime source imports acyclic, excluding type-only references', () => {
  const files = new Set(sourceFiles(sourceRoot, true))
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles: string[] = []
  function visit(file: string): void {
    if (active.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file].map(path => relative(sourceRoot, path)).join(' -> '))
      return
    }
    if (visited.has(file)) return
    active.add(file)
    stack.push(file)
    for (const dependency of dependencies(file, true)) {
      if (!dependency.startsWith('.')) continue
      const base = resolve(dirname(file), dependency.split('?')[0]!)
      const target = [base, base + '.ts', base + '.vue', resolve(base, 'index.ts')].find(candidate => files.has(candidate))
      if (target) visit(target)
    }
    stack.pop()
    active.delete(file)
    visited.add(file)
  }
  for (const file of files) visit(file)
  expect(cycles).toEqual([])
})

it('keeps every component reachable from the application entry', () => {
  const files = new Set<string>()
  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) collect(file)
      else if (/\.(vue|ts)$/.test(file) && !/\.(spec|test|d)\.ts$/.test(file)) files.add(file)
    }
  }
  collect(sourceRoot)
  const reached = new Set<string>()
  function visit(file: string): void {
    if (reached.has(file)) return
    reached.add(file)
    const content = readFileSync(file, 'utf8')
    const script = file.endsWith('.vue')
      ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
      : content
    const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true)
    function dependency(target: string): void {
      if (!target.startsWith('.')) return
      const base = resolve(dirname(file), target.split('?')[0]!)
      const resolved = [base, base + '.ts', base + '.vue', resolve(base, 'index.ts')].find(candidate => files.has(candidate))
      if (resolved) visit(resolved)
    }
    function walk(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const clause = node.importClause
        const named = clause?.namedBindings
        if (clause?.name || !named || !ts.isNamedImports(named) || named.elements.some(element => !element.isTypeOnly)) dependency(node.moduleSpecifier.text)
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text)
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text)
      ts.forEachChild(node, walk)
    }
    walk(tree)
  }
  visit(resolve(sourceRoot, 'main.ts'))
  expect([...files].filter(file => file.endsWith('.vue') && !reached.has(file)).map(file => relative(sourceRoot, file))).toEqual([])
})
