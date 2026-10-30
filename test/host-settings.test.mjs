/**
 * Verifies the host half exposes the endpoint as a dsh settings form: a Config
 * schema whose editable fields are `volatile()` (dsh 0.2.x only projects those
 * into the browser card), live values read back through `get()`, and tools that
 * keep registering with no settings service composed at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')

/** A live `volatile()` value stand-in. */
function volatileValue(value) {
  return { get: () => value }
}

/** Collect the tools/effects apply() registers, and tear everything down after. */
async function withHost(rawConfig, body) {
  const tools = []
  const effects = []
  const disposers = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(build) {
      effects.push(build)
      return () => {}
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
  }

  mod.apply(ctx, rawConfig)
  try {
    await body({ tools, effects })
  } finally {
    for (const build of effects) {
      try {
        const disposer = build()
        if (typeof disposer === 'function') disposers.push(disposer)
      } catch {
        /* ignore teardown noise */
      }
    }
    for (const dispose of disposers) dispose()
  }
}

test('exposes a Config schema for the sts2 entry', () => {
  assert.ok(mod.Config !== undefined, 'Config is exported so the Host serves a form')
  assert.equal(mod.Config.type, 'object')
  const fields = mod.Config.dict
  assert.deepEqual(Object.keys(fields).sort(), [
    'autoPlayPollMs',
    'host',
    'port',
    'requestTimeoutMs',
    'token',
  ])
})

test('only the endpoint fields are editable live', () => {
  const fields = mod.Config.dict
  for (const key of ['host', 'port', 'token']) {
    assert.equal(fields[key].meta.volatile, true, `${key} must be volatile`)
  }
  for (const key of ['autoPlayPollMs', 'requestTimeoutMs']) {
    assert.notEqual(fields[key].meta.volatile, true, `${key} only applies on reload`)
  }
})

test('resolves the documented defaults', () => {
  assert.deepEqual(mod.normalizeConfig({}), {
    host: '127.0.0.1',
    port: 26333,
    token: '',
    autoPlayPollMs: 700,
    requestTimeoutMs: 60000,
  })
})

test('reads live (volatile) fields through get()', () => {
  const config = mod.normalizeConfig({
    host: volatileValue('10.0.0.5'),
    port: volatileValue(30001),
    token: volatileValue('secret'),
    autoPlayPollMs: volatileValue(1500),
    requestTimeoutMs: volatileValue(9000),
  })
  assert.equal(config.host, '10.0.0.5')
  assert.equal(config.port, 30001)
  assert.equal(config.token, 'secret')
  assert.equal(config.autoPlayPollMs, 1500)
  assert.equal(config.requestTimeoutMs, 9000)
})

test('clamps unusable values instead of throwing', () => {
  const config = mod.normalizeConfig({ port: 70000, autoPlayPollMs: 1, requestTimeoutMs: -5 })
  assert.equal(config.port, 26333)
  assert.equal(config.autoPlayPollMs, 200)
  assert.equal(config.requestTimeoutMs, 1000)
})

test('registers every tool without a settings service', async () => {
  await withHost({ host: '127.0.0.1', port: 26333 }, async ({ tools }) => {
    const names = tools.map((tool) => tool.name)
    assert.ok(names.includes('sts2_status'), 'sts2_status registered')
    assert.ok(names.includes('sts2_state'))
    assert.ok(names.includes('sts2_play_card'))
    assert.ok(names.includes('sts2_autoplay'))
    for (const name of ['sts2_pause', 'sts2_resume', 'sts2_save', 'sts2_quit_to_menu', 'sts2_abandon']) {
      assert.ok(names.includes(name), `${name} registered`)
    }
  })
})

test('accepts a live config without touching a settings service', async () => {
  const raw = {
    host: volatileValue('127.0.0.1'),
    port: volatileValue(26334),
    token: volatileValue(''),
  }
  await withHost(raw, async ({ tools }) => {
    assert.ok(tools.some((tool) => tool.name === 'sts2_status'))
  })
})
