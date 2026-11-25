import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { findKeys, Linter, runRenameKey, runInstrumenter } from '../src/index'
import type { I18nextToolkitConfig, Logger } from '../src/index'
import { defaultIgnore, findSourceFiles, findTypesInputFiles, ignoreMatcher, sourceIgnore } from '../src/utils/source-files'

const silent: Logger = { info () {}, warn () {}, error () {} }

// Real fs + real glob on purpose: these tests are about which files glob returns.
describe('source files: one ignore rule for every command', () => {
  let dir: string
  let cwd: string

  const files: Record<string, string> = {
    'src/App.tsx': "export const App = () => <p>{t('app.title')}</p>\n",
    'src/legacy/Old.tsx': "export const Old = () => <p>{t('legacy.title')}</p>\n",
    // a package that ships translatable sources (#213)
    'node_modules/@acme/ui/src/Button.tsx': "export const Button = () => <button>{t('acme.button')}</button>\n",
    'node_modules/@acme/ui/src/Hardcoded.tsx': 'export const Hardcoded = () => <p>Shipped hardcoded text</p>\n',
    'node_modules/other/index.tsx': "export const Other = () => <p>{t('other.title')}</p>\n",
    // a nested node_modules, as in a workspace package
    'packages/app/node_modules/dep/index.tsx': "export const Dep = () => <p>{t('dep.title')}</p>\n",
    'packages/app/src/Page.tsx': "export const Page = () => <p>{t('page.title')}</p>\n",
    'locales/en/translation.json': '{}\n',
    'node_modules/@acme/ui/locales/en/acme.json': '{ "button": "Click" }\n',
  }

  const config = (input: string[], extra: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
    locales: ['en'],
    extract: {
      input,
      output: 'locales/{{language}}/{{namespace}}.json',
      functions: ['t'],
      ...extra,
    },
  })

  const withPackage = ['src/**/*.tsx', 'node_modules/@acme/ui/src/**/*.tsx']

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18next-source-files-'))
    cwd = process.cwd()
    process.chdir(dir)
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  describe('findSourceFiles', () => {
    it('skips node_modules at any depth when no input pattern mentions it', async () => {
      expect(await findSourceFiles(config(['**/*.tsx']))).toEqual([
        'packages/app/src/Page.tsx',
        'src/App.tsx',
        'src/legacy/Old.tsx',
      ])
    })

    it('reads node_modules when an input pattern mentions it', async () => {
      expect(await findSourceFiles(config(withPackage))).toEqual([
        'node_modules/@acme/ui/src/Button.tsx',
        'node_modules/@acme/ui/src/Hardcoded.tsx',
        'src/App.tsx',
        'src/legacy/Old.tsx',
      ])
    })

    it('applies extract.ignore and the extra patterns a command adds', async () => {
      const cfg = config(withPackage, { ignore: 'src/legacy/**' })
      expect(await findSourceFiles(cfg, ['**/Hardcoded.tsx'])).toEqual([
        'node_modules/@acme/ui/src/Button.tsx',
        'src/App.tsx',
      ])
    })
  })

  describe('every command reads the files extract reads', () => {
    it('extract (and status, which uses findKeys) finds the keys in node_modules', async () => {
      const { allKeys } = await findKeys(config(withPackage), silent)
      const keys = [...allKeys.values()].map(k => k.key).sort()
      expect(keys).toEqual(['acme.button', 'app.title', 'legacy.title'])
    })

    it('lint lints node_modules sources when an input pattern names them', async () => {
      const { files: issues } = await new Linter(config(withPackage), silent).run()
      expect(Object.keys(issues)).toEqual(['node_modules/@acme/ui/src/Hardcoded.tsx'])
    })

    it('lint still skips node_modules otherwise, and adds lint.ignore', async () => {
      const cfg: I18nextToolkitConfig = { ...config(['**/*.tsx']), lint: { ignore: ['packages/**'] } }
      await writeFile(join(dir, 'src/Hardcoded.tsx'), 'export const H = () => <p>Local hardcoded text</p>\n')
      await writeFile(join(dir, 'packages/app/src/Hardcoded.tsx'), 'export const H = () => <p>Package hardcoded text</p>\n')
      const { files: issues } = await new Linter(cfg, silent).run()
      expect(Object.keys(issues)).toEqual(['src/Hardcoded.tsx'])
    })

    it('rename-key renames a key in node_modules sources it was extracted from', async () => {
      await writeFile(join(dir, 'locales/en/translation.json'), JSON.stringify({ acme: { button: 'Click' } }))
      const result = await runRenameKey(config(withPackage), 'acme.button', 'acme.cta', { dryRun: true }, silent)
      expect(result.success).toBe(true)
      expect(result.sourceFiles.map(f => f.path)).toEqual(['node_modules/@acme/ui/src/Button.tsx'])
    })

    it('instrument reads the same files, minus its own defaults', async () => {
      const results = await runInstrumenter(config(withPackage), { isDryRun: true, quiet: true }, silent)
      expect(results.files.map(f => f.file)).toContain('node_modules/@acme/ui/src/Hardcoded.tsx')
    })
  })

  describe('types input', () => {
    it('skips node_modules unless types.input mentions it', async () => {
      expect(await findTypesInputFiles(['**/en/*.json'])).toEqual(['locales/en/translation.json'])
      expect(await findTypesInputFiles(['locales/en/*.json', 'node_modules/@acme/ui/locales/en/*.json']))
        .toEqual(expect.arrayContaining(['locales/en/translation.json', 'node_modules/@acme/ui/locales/en/acme.json']))
    })
  })
})

describe('source files: ignore patterns', () => {
  it('drops the node_modules default only when an input pattern mentions node_modules', () => {
    expect(defaultIgnore('src/**/*.ts')).toEqual(['**/node_modules/**'])
    expect(defaultIgnore(['src/**/*.ts', 'node_modules/@acme/sdk/dist/*.d.ts'])).toEqual([])
    expect(defaultIgnore([])).toEqual(['**/node_modules/**'])
  })

  it('combines the default, extract.ignore and command patterns', () => {
    const cfg = { extract: { input: ['src/**/*.ts'], ignore: 'src/legacy/**', output: '' } } as I18nextToolkitConfig
    expect(sourceIgnore(cfg, ['src/admin/**'], undefined, 'dist/**')).toEqual([
      '**/node_modules/**', 'src/legacy/**', 'src/admin/**', 'dist/**',
    ])
  })

  it('matches files and the folders a `/**` pattern covers, with either separator', () => {
    const isIgnored = ignoreMatcher(['**/node_modules/**', './src/i18n/locales/**', '**/*.gen.ts'])
    expect(isIgnored('node_modules')).toBe(true)
    expect(isIgnored('packages/app/node_modules/dep/index.ts')).toBe(true)
    expect(isIgnored('src/i18n/locales')).toBe(true)
    expect(isIgnored('src\\i18n\\locales\\en\\translation.ts')).toBe(true)
    expect(isIgnored('src/api.gen.ts')).toBe(true)
    expect(isIgnored('src/i18n')).toBe(false)
    expect(isIgnored('src/App.tsx')).toBe(false)
  })
})
