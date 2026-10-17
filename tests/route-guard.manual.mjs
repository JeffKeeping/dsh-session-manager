import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = 'D:/Deepseek/test1/plugins/dsh-session-manager/lib/index.js'
const OUT_DIR = 'D:/Deepseek/test1/test-route-guard'

const shim = `
const __path = require_node_path()
function require_node_path() { return { join: (...p) => p.join('/') } }
const dshHomePath = (name) => '/tmp/dsh-home/' + name
const defineDomain = (spec) => spec
function chainable() { const fn = () => chainable(); return new Proxy(fn, { get: () => chainable() }) }
const z = new Proxy({}, { get: () => chainable() })
`

let code = readFileSync(SRC, 'utf8')
code = code.replace('import { dshHomePath } from "@deepseek-ai/dsh-home-paths";', '')
code = code.replace('import { defineDomain } from "@deepseek-ai/dsh-storage-domain";', '')
code = code.replace('import { z } from "zod";', '')
code = code.replace('import { existsSync, readdirSync } from "node:fs";', 'import { existsSync, readdirSync } from "node:fs";')
code = shim + code
code = code.replace(/^export \{/m, 'export {')

mkdirSync(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, 'plugin-under-test.mjs')
writeFileSync(outFile, code)

const mod = await import(pathToFileURL(outFile).href)

function makeCtx(state, { failDomain = false } = {}) {
  const ctx = {
    logger: { warn: (...a) => state.warnings.push(String(a[0])), error() {}, debug() {} },
    fiber: { uid: 1 },
    webServer: {
      register(route) {
        if (state.routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
        state.routes.set(route.path, route)
        return () => state.routes.delete(route.path)
      },
    },
    storageDomain: {
      open: async () => {
        if (failDomain) throw new Error('domain "dsh_delete_session" is already open')
        return { global: { get: () => ({ entries: [] }), set: async () => {} }, close: async () => {} }
      },
      get: () => undefined,
    },
    agents: { get: () => undefined },
    sessionPersistence: { list: async () => [] },
    get: () => undefined,
    on: () => {},
    effect: (factory) => { state.effects.push(factory) },
    inject: (_services, callback) => { callback(ctx) },
  }
  return ctx
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

// 1. Two mounts on the same webserver, as a re-mount does.
{
  const state = { routes: new Map(), effects: [], warnings: [] }
  const ctx = makeCtx(state)
  let threw = null
  try {
    mod.apply(ctx)
    mod.apply(ctx)
    await sleep(60)
  } catch (error) {
    threw = error
  }
  report('duplicate mount does not throw', threw === null, threw ? String(threw) : '')
  report('nine routes installed exactly once', state.routes.size === 9, `routes=${state.routes.size}`)
  report('no route-collision warning needed', state.warnings.length === 0, state.warnings.join(' | '))

  // Disposing the last mount releases its routes.
  const disposers = []
  for (const factory of state.effects) {
    try {
      const cleanup = factory()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    } catch (error) {
      report('effect factory ran', false, String(error))
    }
  }
  for (const dispose of disposers.reverse()) await dispose()
  await sleep(20)
  report('disposal releases the routes', state.routes.size === 0, `routes=${state.routes.size}`)
}

// 2. A failing storage domain must not escape `apply`.
{
  const state = { routes: new Map(), effects: [], warnings: [] }
  const ctx = makeCtx(state, { failDomain: true })
  let threw = null
  try {
    mod.apply(ctx)
    await sleep(60)
  } catch (error) {
    threw = error
  }
  report('setup failure is contained', threw === null, threw ? String(threw) : '')
  report('setup failure is logged', state.warnings.some((w) => w.includes('plugin mount failed')), state.warnings.join(' | '))
}

// 3. A third mount after disposal still installs all routes (no stale table).
{
  const state = { routes: new Map(), effects: [], warnings: [] }
  const ctx = makeCtx(state)
  mod.apply(ctx)
  await sleep(60)
  report('remount after disposal installs routes', state.routes.size === 9, `routes=${state.routes.size}`)
}

rmSync(OUT_DIR, { recursive: true, force: true })
