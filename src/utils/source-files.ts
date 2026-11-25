import { isAbsolute, relative, resolve } from 'node:path'
import { glob } from 'glob'
import { Minimatch, type MinimatchOptions } from 'minimatch'
import type { I18nextToolkitConfig } from '../types.js'

/** A glob option given as one pattern or several, possibly unset */
type Patterns = string | readonly string[] | undefined | null

const toArray = (patterns: Patterns): string[] =>
  (typeof patterns === 'string' ? [patterns] : [...(patterns ?? [])]).filter(Boolean)

/** The working directory's `node_modules`, which a pattern reads in only when it names node_modules */
export const NODE_MODULES_IGNORE = 'node_modules/**'

/** On Windows a backslash is a path separator, not an escape: a pattern built with `path.join` matches there */
const windowsPathsNoEscape = process.platform === 'win32'

/**
 * Whether a glob pattern names `node_modules`, and so reads in it: a dependency's `.d.ts` for the type-aware
 * resolver (#294), a package that ships translatable sources (#213) or its translations. A negated pattern
 * (`!**\/node_modules/**`, as i18next-parser configs have) does not: glob reads nothing with it.
 */
export const namesNodeModules = (pattern: string): boolean => !pattern.startsWith('!') && pattern.includes('node_modules')

/** Whether a path (relative to the working directory, or absolute) is in a `node_modules` folder, at any depth */
export function inNodeModules (path: string): boolean {
  return relative(process.cwd(), resolve(process.cwd(), path)).split(/[\\/]/).includes('node_modules')
}

/** What a command skips besides the default: `extract.ignore`, then what the command adds (e.g. `lint.ignore`) */
export function sourceIgnore (config: Pick<I18nextToolkitConfig, 'extract'>, ...extra: Patterns[]): string[] {
  return [...toArray(config.extract.ignore), ...extra.flatMap(toArray)]
}

/**
 * The files (no directories: a folder named `abc.tsx` matches `*.tsx`) that `patterns` match relative to the
 * working directory, minus `ignore` and the working directory's `node_modules`, which only a pattern that names
 * node_modules reads in. Sorted: glob's order is not stable across runs, and the file read first decides e.g.
 * which default value a key gets (#296). `sort: false` keeps glob's order, for `types`, whose generated
 * interface follows it.
 */
export async function globFiles (patterns: string | string[], ignore: string[], { sort = true } = {}): Promise<string[]> {
  const all = toArray(patterns)
  const named = all.filter(namesNodeModules)
  const options = { cwd: process.cwd(), nodir: true, windowsPathsNoEscape }
  let files: string[]
  if (named.length === 0) {
    files = await glob(patterns, { ...options, ignore: [NODE_MODULES_IGNORE, ...ignore] })
  } else if (named.length === all.length) {
    files = await glob(patterns, { ...options, ignore })
  } else {
    // One pattern into a package does not open all of node_modules to a `**/*.tsx` beside it
    const others = all.filter(p => !namesNodeModules(p))
    const [a, b] = await Promise.all([
      glob(others, { ...options, ignore: [NODE_MODULES_IGNORE, ...ignore] }),
      glob(named, { ...options, ignore }),
    ])
    files = [...new Set([...a, ...b])]
  }
  return sort ? files.sort() : files
}

/**
 * The source files of `extract.input`, the same for every command that reads them (`extract`, `status`, `lint`
 * and their watchers): node_modules only for a pattern that names it, minus `extract.ignore` and `extraIgnore`.
 */
export async function findSourceFiles (config: Pick<I18nextToolkitConfig, 'extract'>, ...extraIgnore: Patterns[]): Promise<string[]> {
  return globFiles(config.extract.input, sourceIgnore(config, ...extraIgnore))
}

/**
 * The source files `instrument` and `rename-key` may rewrite: those of {@link findSourceFiles}, but never one in
 * a `node_modules` folder (at any depth, also outside the working directory), even when an input pattern names
 * it to read a package's keys or types. A dependency is not the project's code to change, and a reinstall would
 * undo the change anyway.
 */
export async function findWritableSourceFiles (config: Pick<I18nextToolkitConfig, 'extract'>, ...extraIgnore: Patterns[]): Promise<string[]> {
  const files = await globFiles(config.extract.input, sourceIgnore(config, '**/node_modules/**', ...extraIgnore))
  return files.filter(f => !inNodeModules(f))
}

/** The translation files `types` reads from `types.input`: node_modules only for a pattern that names it */
export async function findTypesInputFiles (input: string | string[]): Promise<string[]> {
  return globFiles(input, [], { sort: false })
}

// Paths as glob compares them: relative to the working directory with `/` (`.` for itself), and absolute
const relativePath = (path: string) => relative(process.cwd(), resolve(process.cwd(), path)).replace(/\\/g, '/') || '.'
const absolutePath = (path: string) => resolve(process.cwd(), path).replace(/\\/g, '/')
const isAbsolutePattern = (pattern: string) => isAbsolute(pattern) || /^[a-z]:\//i.test(pattern)

/** glob reads `ignore` patterns this way (its `Ignore` class) */
const IGNORE_OPTIONS: MinimatchOptions = { dot: true, nocomment: true, nonegate: true, optimizationLevel: 2, windowsPathsNoEscape }

/**
 * `ignore` read as glob reads it, for the watchers: an entry a pattern matches is skipped, but the files in a
 * folder only for a pattern ending in `/**` (`src/legacy` skips no file in it, `src/generated/*` none in a
 * folder below it).
 */
function globIgnore (ignore: string[]) {
  const entries: Array<{ mm: Minimatch, absolute: boolean }> = []
  const children: Array<{ mm: Minimatch, absolute: boolean }> = []
  for (const pattern of ignore) {
    for (let parts of new Minimatch(pattern, IGNORE_OPTIONS).globParts) {
      while (parts[0] === '.') parts = parts.slice(1)
      const glob = parts.join('/')
      const matcher = { mm: new Minimatch(glob, IGNORE_OPTIONS), absolute: isAbsolutePattern(glob) }
      entries.push(matcher)
      if (parts[parts.length - 1] === '**') children.push(matcher)
    }
  }
  const test = (matchers: typeof entries, path: string, folder: boolean) => {
    const rel = relativePath(path)
    const abs = absolutePath(path)
    return matchers.some(({ mm, absolute }) => {
      const p = absolute ? abs : rel
      return folder ? mm.match(`${p}/`) : mm.match(p) || mm.match(`${p}/`)
    })
  }
  return {
    ignored: (path: string) => test(entries, path, false),
    childrenIgnored: (path: string) => test(children, path, true),
  }
}

/** Whether `ignore` (read as glob reads it) skips a path, for a watcher's list of files */
export function ignoreMatcher (ignore: string[]): (path: string) => boolean {
  return globIgnore(ignore).ignored
}

/**
 * For `extract --watch`, by path (relative to the working directory, or absolute): whether a file is one
 * {@link findSourceFiles} returns, and whether a folder holds none of them for sure, so the watcher does not
 * descend into it (one no input pattern can reach, a node_modules only patterns that do not name it reach,
 * one `ignore` skips the files in).
 */
export function sourceMatcher (config: Pick<I18nextToolkitConfig, 'extract'>, ...extraIgnore: Patterns[]): { isSource: (path: string) => boolean, isSkippedFolder: (path: string) => boolean } {
  const inputs = toArray(config.extract.input)
    .filter(p => !p.startsWith('!'))
    .map(p => p.replace(/^\.\//, ''))
    .map(p => ({ mm: new Minimatch(p, { windowsPathsNoEscape }), named: namesNodeModules(p), absolute: isAbsolutePattern(p) }))
  const ignore = globIgnore(sourceIgnore(config, ...extraIgnore))
  const inRootNodeModules = (rel: string) => rel === 'node_modules' || rel.startsWith('node_modules/')
  const reaches = (path: string, partial: boolean) => {
    const rel = relativePath(path)
    const abs = absolutePath(path)
    return inputs.some(({ mm, named, absolute }) => mm.match(absolute ? abs : rel, partial) && (named || !inRootNodeModules(rel)))
  }
  return {
    isSource: (path: string) => reaches(path, false) && !ignore.ignored(path),
    isSkippedFolder: (path: string) => relativePath(path) !== '.' && (ignore.childrenIgnored(path) || !reaches(path, true)),
  }
}
