import { glob } from 'glob'
import { minimatch } from 'minimatch'
import type { I18nextToolkitConfig } from '../types.js'

/** A glob option given as one pattern or several, possibly unset */
type Patterns = string | readonly string[] | undefined | null

const toArray = (patterns: Patterns): string[] =>
  (typeof patterns === 'string' ? [patterns] : [...(patterns ?? [])]).filter(Boolean)

/** `node_modules`, at any depth */
export const NODE_MODULES_IGNORE = '**/node_modules/**'

/**
 * The ignore every glob over the project starts from: `node_modules` (at any depth), unless one of the
 * `input` patterns mentions it. Whoever globs into it means it: a dependency's `.d.ts` for the type-aware
 * resolver (#294), a package that ships translatable sources (#213), resources a package ships.
 */
export function defaultIgnore (input: Patterns): string[] {
  return toArray(input).some(p => p.includes('node_modules')) ? [] : [NODE_MODULES_IGNORE]
}

/**
 * The globs every command that reads the source files of `extract.input` skips, so `extract`, `status`, `lint`,
 * `instrument` and `rename-key` (and their watchers) read the same files: the default ignore, `extract.ignore`,
 * then what the command adds (`lint.ignore`, the stories and fixtures `instrument` leaves alone).
 */
export function sourceIgnore (config: Pick<I18nextToolkitConfig, 'extract'>, ...extra: Patterns[]): string[] {
  return [...defaultIgnore(config.extract.input), ...toArray(config.extract.ignore), ...extra.flatMap(toArray)]
}

/**
 * The files (no directories, a folder named `abc.tsx` matches `*.tsx`) that `patterns` match relative to the
 * working directory, without those `ignore` matches. Sorted: glob's order is not stable across runs, and the
 * file read first decides e.g. which default value a key gets (#296). `sort: false` keeps glob's order, for
 * `types`, whose generated interface follows it.
 */
export async function globFiles (patterns: string | string[], ignore: string[], { sort = true } = {}): Promise<string[]> {
  const files = await glob(patterns, { ignore, cwd: process.cwd(), nodir: true })
  return sort ? files.sort() : files
}

/** The translation files `types` reads from `types.input`, in glob's order */
export async function findTypesInputFiles (input: string | string[]): Promise<string[]> {
  return globFiles(input, defaultIgnore(input), { sort: false })
}

/** The source files of `extract.input`, minus {@link sourceIgnore} (with `extraIgnore`) */
export async function findSourceFiles (config: Pick<I18nextToolkitConfig, 'extract'>, ...extraIgnore: Patterns[]): Promise<string[]> {
  return globFiles(config.extract.input, sourceIgnore(config, ...extraIgnore))
}

/**
 * Whether a path (relative to the working directory, `/` or `\` separated) is one `ignore` skips, for the
 * watchers, as glob reads `ignore`: a pattern ending in `/**` also matches the folder itself, so a watcher
 * does not descend into it.
 */
export function ignoreMatcher (ignore: string[]): (path: string) => boolean {
  const patterns = ignore.map(p => p.replace(/^\.\//, ''))
  return (path: string) => {
    const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
    return patterns.some(g => minimatch(p, g, { dot: true }) || (g.endsWith('/**') && minimatch(p, g.slice(0, -3), { dot: true })))
  }
}
