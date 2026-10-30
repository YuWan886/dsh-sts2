/**
 * Verifies the browser half the way dsh's boot protocol loads it:
 *   classic script → window.__ModuleLoader__.load({id, factory}) → factory(require)
 * No browser and no React build step, so the test stubs a minimal React.
 *
 * The card registers into `plugins.row.config` under `<package>#<row id>` and
 * receives `form.state` / `form.mutate(operations, revision)` from the Plugins
 * page — that is the dsh 0.2.x contract, not a `settingsScope` service.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** Minimal React stand-in: enough for createElement / useState / useEffect. */
function fakeReact() {
  const effectCalls = []
  const React = {
    createElement(type, props, ...children) {
      // Function components are rendered eagerly; hooks stay plain snapshots.
      if (typeof type === 'function') return type({ ...(props ?? {}), children: children.flat() })
      return { type, props: props ?? {}, children: children.flat().filter((c) => c != null) }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect(fn, deps) {
      effectCalls.push({ fn, deps })
    },
  }
  return { React, effectCalls }
}

/** Load the bundle in a sandbox and return what it registered. */
function loadBundle({ withLoader = true } = {}) {
  const registrations = []
  const sandbox = { console }
  sandbox.globalThis = sandbox
  if (withLoader) {
    sandbox.__ModuleLoader__ = {
      load(registration) {
        registrations.push(registration)
      },
    }
  }
  runInContext(SOURCE, createContext(sandbox), { filename: CLIENT_PATH.pathname })
  return registrations
}

/** A cordis-like client context whose slots ledger records registrations. */
function fakeClientContext({ throwing = false } = {}) {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    slots: {
      inject(name, body) {
        if (throwing) throw new Error('slot ledger unavailable')
        injected.push(name)
        const disposer = typeof body === 'function' ? body() : undefined
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
}

/** The page hands the card these props. */
function pageProps({ status = 'ready', value = { host: '127.0.0.1', port: 26333 }, writable = true } = {}) {
  const mutations = []
  return {
    props: {
      view: 'page',
      form: {
        state: { status, value, writable, revision: 7 },
        mutate(operations, revision) {
          mutations.push({ operations, revision })
          return Promise.resolve(true)
        },
      },
    },
    mutations,
  }
}

function loadPlugin() {
  const [registration] = loadBundle()
  const { React } = fakeReact()
  return registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
}

test('bundle registers a module factory under its package name', () => {
  const registrations = loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-sts2')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('bundle is inert when the boot facade is absent', () => {
  assert.deepEqual(loadBundle({ withLoader: false }), [])
})

test('the plugin requires only the slots service', () => {
  const plugin = loadPlugin()
  assert.equal(plugin.name, 'dsh-sts2')
  // Cross-realm array: compare contents, not the vm context's Array prototype.
  assert.equal(plugin.inject.join(','), 'slots')
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the sts2 row card into plugins.row.config', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)

  assert.deepEqual(ctx.injected, ['plugins.row.config'])
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].options.name, 'plugins.row.config')
  assert.equal(ctx.registered[0].options.key, 'dsh-sts2#sts2')
  assert.equal(typeof ctx.registered[0].component, 'function')
})

test('the summary view is plain text for the row subtitle', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)
  const summary = ctx.registered[0].component({ view: 'summary' })
  assert.equal(typeof summary, 'string')
  assert.match(summary, /Slay the Spire 2/)
})

test('the page seeds its fields from form.state.value', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)
  const { props } = pageProps({ value: { host: '127.0.0.1', port: 26334 } })
  const tree = ctx.registered[0].component(props)

  assert.equal(findInput(tree, 'number')?.props.value, '26334')
  assert.equal(findInput(tree, 'text')?.props.value, '127.0.0.1')
  assert.match(collectText(tree), /127\.0\.0\.1:26334/)
})

test('save writes host and port through form.mutate with the read revision', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)
  const { props, mutations } = pageProps()
  const tree = ctx.registered[0].component(props)

  findButton(tree, '保存 / save').props.onClick()

  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].revision, 7)
  // Cross-realm objects: compare their JSON shape, not Object prototypes.
  assert.equal(
    JSON.stringify(mutations[0].operations),
    JSON.stringify([
      { op: 'set', path: ['host'], value: '127.0.0.1' },
      { op: 'set', path: ['port'], value: 26333 },
    ]),
  )
})

test('clear token writes an empty token', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)
  const { props, mutations } = pageProps()
  const tree = ctx.registered[0].component(props)

  findButton(tree, '清空 token').props.onClick()

  assert.equal(
    JSON.stringify(mutations[0].operations),
    JSON.stringify([{ op: 'set', path: ['token'], value: '' }]),
  )
})

test('an unavailable form degrades instead of throwing', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)
  const { props } = pageProps({ status: 'unavailable', value: undefined })
  assert.doesNotThrow(() => ctx.registered[0].component(props))
  const tree = ctx.registered[0].component(props)
  assert.match(collectText(tree), /Slay the Spire 2 bridge/)
  assert.equal(findButton(tree, '保存 / save').props.disabled, true)
})

test('a page without form props still renders', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext()
  plugin.apply(ctx)
  assert.doesNotThrow(() => ctx.registered[0].component({ view: 'page' }))
})

test('a throwing slot ledger never escapes apply', () => {
  const plugin = loadPlugin()
  const ctx = fakeClientContext({ throwing: true })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(ctx.registered.length, 0)
})

function collectText(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  return collectText(node.children)
}

function walk(node, visit) {
  if (node == null || typeof node !== 'object') return undefined
  const found = visit(node)
  if (found !== undefined) return found
  for (const child of node.children ?? []) {
    const nested = walk(child, visit)
    if (nested !== undefined) return nested
  }
  return undefined
}

function findInput(node, type) {
  return walk(node, (candidate) =>
    candidate.type === 'input' && candidate.props?.type === type ? candidate : undefined,
  )
}

function findButton(node, label) {
  return walk(node, (candidate) =>
    candidate.type === 'button' && collectText(candidate) === label ? candidate : undefined,
  )
}
