import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { findKeys, Linter, runRenameKey, runInstrumenter, runTypesGenerator } from '../src/index'
import type { I18nextToolkitConfig, Logger } from '../src/index'
import {
  findSourceFiles, findTypesInputFiles, findWritableSourceFiles, ignoreMatcher, inNodeModules, namesNodeModules,
  sourceIgnore, sourceMatcher
} from '../src/utils/source-files'
import { normalizePath } from './utils/path'

const silent: Logger = { info () {}, warn () {}, error () {} }
const posix = (paths: string[]) => paths.map(normalizePath)

const config = (input: string | string[], extract: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
  locales: ['en'],
  extract: {
    input,
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    ...extract,
  },
})

/** Every file and folder below `root`, relative, with `/` */
async function walk (root: string, prefix = ''): Promise<{ files: string[], folders: string[] }> {
  const files: string[] = []
  const folders: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      folders.push(path)
      const below = await walk(root, path)
      files.push(...below.files)
      folders.push(...below.folders)
    } else {
      files.push(path)
    }
  }
  return { files, folders }
}

// Real fs + real glob on purpose: these tests are about which files glob returns.
describe('source files: one ignore rule for every command', () => {
  let dir: string
  let cwd: string

  const fixture: Record<string, string> = {
    'src/App.tsx': "export const App = () => <p>{t('app.title')}</p>\n",
    'src/legacy/Old.tsx': "export const Old = () => <p>{t('legacy.title')}</p>\n",
    'src/latest/News.tsx': "export const News = () => <p>{t('news.title')}</p>\n",
    'src/generated/top.tsx': "t('gen.top')\n",
    'src/generated/api/client.tsx': "t('gen.api')\n",
    'src/.cache/Cached.tsx': "t('cache.title')\n",
    // a package that ships translatable sources (#213)
    'node_modules/@acme/ui/src/Button.tsx': "export const Button = () => <button>{t('acme.button')}</button>\n",
    'node_modules/@acme/ui/src/Hardcoded.tsx': 'export const Hardcoded = () => <p>Shipped hardcoded text</p>\n',
    'node_modules/other/index.tsx': "export const Other = () => <p>{t('other.title')}</p>\n",
    // a workspace package with its own node_modules
    'packages/app/node_modules/dep/index.tsx': "export const Dep = () => <p>{t('dep.title')}</p>\n",
    'packages/app/src/Page.tsx': "export const Page = () => <p>{t('page.title')}</p>\n",
    'locales/en/translation.json': '{ "app": { "title": "App" } }\n',
    'node_modules/@acme/ui/locales/en/acme.json': '{ "button": "Click" }\n',
  }

  const withPackage = ['src/*.tsx', 'node_modules/@acme/ui/src/**/*.tsx']

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18next-source-files-'))
    cwd = process.cwd()
    process.chdir(dir)
    for (const [path, content] of Object.entries(fixture)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  describe('findSourceFiles', () => {
    it("skips the working directory's node_modules when no input pattern names it", async () => {
      const files = posix(await findSourceFiles(config(['src/*.tsx', 'packages/*/src/**/*.tsx'])))
      expect(files).toEqual(['packages/app/src/Page.tsx', 'src/App.tsx'])
    })

    it('reads in node_modules with a pattern that names it', async () => {
      expect(posix(await findSourceFiles(config(withPackage)))).toEqual([
        'node_modules/@acme/ui/src/Button.tsx',
        'node_modules/@acme/ui/src/Hardcoded.tsx',
        'src/App.tsx',
      ])
    })

    it('does not open all of node_modules to the other patterns', async () => {
      const files = posix(await findSourceFiles(config(['**/*.tsx', 'node_modules/@acme/ui/src/Button.tsx'])))
      expect(files).toContain('node_modules/@acme/ui/src/Button.tsx')
      expect(files).not.toContain('node_modules/@acme/ui/src/Hardcoded.tsx')
      expect(files).not.toContain('node_modules/other/index.tsx')
    })

    it('a negated pattern does not name node_modules', async () => {
      expect(posix(await findSourceFiles(config(['**/index.tsx', '!**/node_modules/**']))))
        .toEqual(['packages/app/node_modules/dep/index.tsx'])
    })

    it('applies extract.ignore and the patterns a command adds', async () => {
      const files = await findSourceFiles(config(withPackage, { ignore: 'src/App.tsx' }), ['**/Hardcoded.tsx'])
      expect(posix(files)).toEqual(['node_modules/@acme/ui/src/Button.tsx'])
    })
  })

  describe('findWritableSourceFiles', () => {
    it('never returns a file in node_modules, at any depth, even when an input pattern names it', async () => {
      const files = posix(await findWritableSourceFiles(config(['**/*.tsx', ...withPackage])))
      expect(files.filter(f => f.includes('node_modules'))).toEqual([])
      expect(files).toContain('packages/app/src/Page.tsx')
    })

    it('nor one in a node_modules outside the working directory', async () => {
      process.chdir(join(dir, 'packages/app'))
      const files = posix(await findWritableSourceFiles(config(['src/**/*.tsx', '../../**/*.tsx'])))
      expect(files.filter(f => f.includes('node_modules'))).toEqual([])
      expect(files).toContain('src/Page.tsx')
    })
  })

  // The watcher reacts to, and only to, the files the command reads, and skips only folders that hold none of them
  describe('sourceMatcher agrees with findSourceFiles', () => {
    const cases: Array<[string, I18nextToolkitConfig]> = [
      ['ignore patterns without a trailing /**', config(['src/**/*.tsx'], { ignore: ['src/legacy', 'src/generated/*', '**/*test*'] })],
      ['a broad pattern beside a package', config(['**/*.tsx', 'node_modules/@acme/ui/src/**/*.tsx'])],
      ['workspace packages and ./', config(['packages/*/src/**/*.tsx', './src/**/*.tsx'], { ignore: './src/legacy/**' })],
      ['a negated pattern', config(['src/**/*.tsx', '!**/node_modules/**'])],
      ['an absolute pattern', config([join('{dir}', 'src/**/*.tsx').replace(/\\/g, '/')])],
    ]

    it.each(cases)('%s', async (_name, cfg) => {
      cfg.extract.input = [cfg.extract.input].flat().map(p => p.replace('{dir}', process.cwd().replace(/\\/g, '/')))
      const found = new Set(posix(await findSourceFiles(cfg)).map(f => normalizePath(f.replace(process.cwd(), '').replace(/^[\\/]/, ''))))
      const { isSource, isSkippedFolder } = sourceMatcher(cfg)
      const { files, folders } = await walk(dir)
      for (const file of files) expect([file, isSource(file)]).toEqual([file, found.has(file)])
      for (const folder of folders.filter(isSkippedFolder)) {
        expect([folder, [...found].filter(f => f.startsWith(`${folder}/`))]).toEqual([folder, []])
      }
      expect(found.size).toBeGreaterThan(0)
    })

    it('skips the folders no pattern reads in', () => {
      const broad = sourceMatcher(config(['**/*.tsx', 'node_modules/@acme/ui/src/**/*.tsx']))
      expect(broad.isSkippedFolder('node_modules/other')).toBe(true)
      expect(broad.isSkippedFolder('node_modules')).toBe(false)
      expect(broad.isSkippedFolder('node_modules/@acme/ui/src')).toBe(false)
      expect(broad.isSkippedFolder('src/.cache')).toBe(true)

      const workspace = sourceMatcher(config(['packages/*/src/**/*.tsx']))
      expect(workspace.isSkippedFolder('packages/app/node_modules')).toBe(true)
      expect(workspace.isSkippedFolder('packages/app/src')).toBe(false)

      const negated = sourceMatcher(config(['src/**/*.tsx', '!**/node_modules/**']))
      expect(negated.isSkippedFolder('node_modules')).toBe(true)
      expect(negated.isSkippedFolder('.')).toBe(false)

      const ignored = sourceMatcher(config(['src/**/*.tsx'], { ignore: ['src/legacy', 'src/generated/**'] }))
      expect(ignored.isSkippedFolder('src/legacy')).toBe(false)
      expect(ignored.isSkippedFolder('src/generated')).toBe(true)
      expect(ignored.isSkippedFolder('src\\generated\\api')).toBe(true)
    })
  })

  describe('the commands that read source files read the files extract reads', () => {
    it('extract (and status, which uses findKeys) finds the keys in node_modules', async () => {
      const { allKeys } = await findKeys(config(withPackage), silent)
      expect([...allKeys.values()].map(k => k.key).sort()).toEqual(['acme.button', 'app.title'])
    })

    it('lint lints node_modules sources when an input pattern names them', async () => {
      const { files: issues } = await new Linter(config(withPackage), silent).run()
      expect(posix(Object.keys(issues))).toEqual(['node_modules/@acme/ui/src/Hardcoded.tsx'])
    })

    it('lint still skips node_modules otherwise, and adds lint.ignore', async () => {
      const cfg: I18nextToolkitConfig = { ...config(['**/*.tsx']), lint: { ignore: ['packages/**'] } }
      await writeFile(join(dir, 'src/Hardcoded.tsx'), 'export const H = () => <p>Local hardcoded text</p>\n')
      await writeFile(join(dir, 'packages/app/src/Hardcoded.tsx'), 'export const H = () => <p>Package hardcoded text</p>\n')
      const { files: issues } = await new Linter(cfg, silent).run()
      expect(posix(Object.keys(issues))).toEqual(['src/Hardcoded.tsx'])
    })

    it('types reads node_modules only with a types.input pattern that names it', async () => {
      const generate = async (input: string[]) => {
        await runTypesGenerator({ ...config('src/*.tsx'), types: { input, output: 'types/i18next.d.ts' } }, { quiet: true, logger: silent })
        return readFile(join(dir, 'types/resources.d.ts'), 'utf-8')
      }
      const own = await generate(['**/en/*.json'])
      expect(own).toContain('translation')
      expect(own).not.toContain('acme')
      expect(await generate(['locales/en/*.json', 'node_modules/@acme/ui/locales/en/*.json'])).toContain('acme')
      expect(posix(await findTypesInputFiles(['**/en/*.json']))).toEqual(['locales/en/translation.json'])
    })
  })

  describe('the commands that rewrite source files leave node_modules alone', () => {
    it('rename-key renames in the project files extract reads', async () => {
      const result = await runRenameKey(config(withPackage), 'app.title', 'app.heading', {}, silent)
      expect(result.success).toBe(true)
      expect(result.sourceFiles.map(f => normalizePath(f.path))).toEqual(['src/App.tsx'])
      expect(await readFile(join(dir, 'src/App.tsx'), 'utf-8')).toContain("t('app.heading')")
    })

    it('rename-key refuses a key used in node_modules, which extract would add back', async () => {
      await writeFile(join(dir, 'locales/en/translation.json'), JSON.stringify({ acme: { button: 'Click' } }))
      await writeFile(join(dir, 'src/Cta.tsx'), "export const Cta = () => <p>{t('acme.button')}</p>\n")
      const result = await runRenameKey(config(withPackage), 'acme.button', 'acme.cta', {}, silent)
      expect(result.success).toBe(false)
      expect(normalizePath(result.error)).toContain('node_modules/@acme/ui/src/Button.tsx')
      // nothing was changed
      expect(await readFile(join(dir, 'src/Cta.tsx'), 'utf-8')).toContain("t('acme.button')")
      expect(await readFile(join(dir, 'node_modules/@acme/ui/src/Button.tsx'), 'utf-8')).toBe(fixture['node_modules/@acme/ui/src/Button.tsx'])
      expect(JSON.parse(await readFile(join(dir, 'locales/en/translation.json'), 'utf-8'))).toEqual({ acme: { button: 'Click' } })
    })

    it('instrument rewrites the project, not a package an input pattern names', async () => {
      await writeFile(join(dir, 'src/Hello.tsx'), 'export const Hello = () => <p>Hello there friend</p>\n')
      const results = await runInstrumenter(config(withPackage), { isDryRun: true, quiet: true }, silent)
      const instrumented = posix(results.files.map(f => f.file))
      expect(instrumented).toContain('src/Hello.tsx')
      expect(instrumented.filter(f => f.includes('node_modules'))).toEqual([])
    })
  })
})

describe('source files: patterns', () => {
  it('a pattern names node_modules unless it is negated', () => {
    expect(namesNodeModules('node_modules/@acme/sdk/dist/*.d.ts')).toBe(true)
    expect(namesNodeModules('src/**/*.ts')).toBe(false)
    expect(namesNodeModules('!**/node_modules/**')).toBe(false)
  })

  it('a path is in node_modules at any depth, with either separator', () => {
    expect(inNodeModules('node_modules/x/a.ts')).toBe(true)
    expect(inNodeModules('packages\\app\\node_modules\\x\\a.ts')).toBe(true)
    expect(inNodeModules('../shared/node_modules/x/a.ts')).toBe(true)
    expect(inNodeModules('src/node_modules_like/a.ts')).toBe(false)
  })

  it('combines extract.ignore and the patterns a command adds', () => {
    const cfg = { extract: { input: ['src/**/*.ts'], ignore: 'src/legacy/**', output: '' } } as I18nextToolkitConfig
    expect(sourceIgnore(cfg, ['src/admin/**'], undefined, 'dist/**')).toEqual(['src/legacy/**', 'src/admin/**', 'dist/**'])
  })

  it('reads ignore patterns as glob does', () => {
    const isIgnored = ignoreMatcher(['./src/i18n/locales/**', '**/*.gen.ts', 'src/legacy'])
    expect(isIgnored('src/i18n/locales')).toBe(true)
    expect(isIgnored('src\\i18n\\locales\\en\\translation.ts')).toBe(true)
    expect(isIgnored('src/api.gen.ts')).toBe(true)
    expect(isIgnored('src/legacy')).toBe(true)
    expect(isIgnored('src/legacy/Old.ts')).toBe(false)
    expect(isIgnored('src/App.tsx')).toBe(false)
  })
})
