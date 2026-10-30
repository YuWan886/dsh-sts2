/**
 * Take-over behaviour: exactly one conversation drives the run.
 *
 * The game only offers an invitation after it has seen no driving traffic for a while, so the
 * plugin must stay quiet while its own loop is really driving, and must serve the invitation
 * (instead of ignoring it) once that loop has gone quiet — that is what keeps a forgotten
 * autoplay loop from owning the game, and it is the bug these tests pin down.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

const mod = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll a predicate until it holds, so the tests do not depend on exact timer ticks. */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  return false
}

/** A fake game bridge: line-delimited JSON, answering from the mutable `game` object. */
function startFakeGame(game) {
  const requests = []
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        const request = JSON.parse(line)
        requests.push(request)
        const answer = (text) => socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { text } })}\n`)

        if (request.call === 'sts2_state') answer(JSON.stringify(game.state))
        else if (request.call === 'sts2_takeover') answer(JSON.stringify(game.take))
        else if (request.call === 'sts2_hello') {
          answer(JSON.stringify({ game_version: '0.111.0', bridge_version: 'test', allow_actions: true }))
        } else answer('{}')
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        callsTo: (name) => requests.filter((request) => request.call === name),
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** One ordinary snapshot of a run that is waiting for input. */
function runState(overrides = {}) {
  return {
    phase: 'combat',
    actionable: true,
    token: 't1',
    run: { character: 'Ironclad', act: 1, floor: 3, hp: 40, max_hp: 80, gold: 99 },
    ...overrides,
  }
}

function menuState() {
  return { phase: 'menu', actionable: false, token: 'm1', menu: { characters: [], can_continue: false } }
}

/** The agent that calls sts2_autoplay, plus the record its follow-ups land in. */
function drivingAgent(id = 'driver') {
  const record = { id, prompts: [], status: 'idle' }
  record.agent = {
    id,
    status: 'idle',
    followup(message) {
      record.prompts.push(message)
    },
  }
  return record
}

/** A session controller whose `createSession` records the conversations the plugin opens. */
function sessionControllerFor(created) {
  return {
    sessionController: {
      agents: {
        async createSession({ cwd }) {
          const record = { id: `new-${created.length + 1}`, cwd, prompts: [] }
          created.push(record)
          return {
            agent: {
              id: record.id,
              status: 'idle',
              followup(message) {
                record.prompts.push(message)
              },
            },
          }
        },
      },
    },
  }
}

/** Apply the plugin against the fake bridge and start its timers. */
function startHost(port, services) {
  const tools = new Map()
  const effects = []

  mod.apply({
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
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
    get(name) {
      return services?.[name]
    },
  }, {
    host: '127.0.0.1',
    port,
    autoPlayPollMs: 200,
    takeoverPollMs: 1000,
    autoTakeover: true,
  })

  const disposers = effects.map((build) => build()).filter((dispose) => typeof dispose === 'function')
  return {
    tools,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

test('opens a conversation when the game offers an unclaimed run', async () => {
  const game = {
    state: runState(),
    take: { take: true, run_token: 'run-1', prompt: 'PLAY IT', workspace: 'C:/work' },
  }
  const fake = await startFakeGame(game)
  const created = []
  const host = startHost(fake.port, sessionControllerFor(created))

  try {
    assert.ok(await waitFor(() => created.length === 1), 'a conversation was opened')
    assert.equal(created[0].cwd, 'C:/work')
    assert.equal(created[0].prompts.length, 1)
    assert.equal(created[0].prompts[0].content[0].text, 'PLAY IT')
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('a live autoplay loop keeps the poller from claiming the run', async () => {
  const game = { state: runState(), take: { take: true, run_token: 'run-2', prompt: 'PLAY IT' } }
  const fake = await startFakeGame(game)
  const created = []
  const host = startHost(fake.port, sessionControllerFor(created))
  const driver = drivingAgent()

  try {
    const text = await host.tools.get('sts2_autoplay').execute({ enabled: true }, { agent: driver.agent })
    assert.match(text, /Autoplay is on/)

    await sleep(1400)
    assert.equal(fake.callsTo('sts2_takeover').length, 0, 'the poller stays quiet while the loop drives')
    assert.equal(created.length, 0)
    assert.ok(fake.callsTo('sts2_state').length >= 3, 'the loop itself keeps the bridge busy')
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('refuses to arm while the game is only at the main menu', async () => {
  const game = { state: menuState(), take: { take: false, reason: 'no_ai_teammate' } }
  const fake = await startFakeGame(game)
  const host = startHost(fake.port, sessionControllerFor([]))

  try {
    const text = await host.tools.get('sts2_autoplay').execute({ enabled: true }, { agent: drivingAgent().agent })
    assert.match(text, /no run is in progress/)

    const before = fake.callsTo('sts2_state').length
    await sleep(700)
    assert.equal(fake.callsTo('sts2_state').length, before, 'an empty menu is not polled')
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('stops polling once the game is back at the main menu', async () => {
  const game = { state: runState(), take: { take: false, reason: 'already_driving' } }
  const fake = await startFakeGame(game)
  const host = startHost(fake.port, sessionControllerFor([]))

  try {
    await host.tools.get('sts2_autoplay').execute({ enabled: true }, { agent: drivingAgent().agent })
    await sleep(500)
    assert.ok(fake.callsTo('sts2_state').length >= 2, 'the run is polled')

    game.state = menuState()
    await sleep(500)
    const stopped = fake.callsTo('sts2_state').length
    await sleep(600)
    assert.equal(fake.callsTo('sts2_state').length, stopped, 'the loop ends with the run')
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('handoff stops the local loop and opens a fresh conversation', async () => {
  const game = {
    state: runState(),
    take: { take: true, run_token: 'run-3', prompt: 'MOVE OVER', workspace: 'C:/work' },
  }
  const fake = await startFakeGame(game)
  const created = []
  const host = startHost(fake.port, sessionControllerFor(created))
  const driver = drivingAgent()

  try {
    await host.tools.get('sts2_autoplay').execute({ enabled: true }, { agent: driver.agent })

    const text = await host.tools.get('sts2_handoff').execute({}, { agent: driver.agent })
    assert.match(text, /Handed over/)
    assert.equal(created.length, 1)
    assert.equal(created[0].prompts[0].content[0].text, 'MOVE OVER')

    // The old conversation must not keep being woken by the loop.
    const woken = driver.prompts.length
    await sleep(600)
    assert.equal(driver.prompts.length, woken)
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('reports why a hand-over had to wait instead of pretending it happened', async () => {
  const game = { state: runState(), take: { take: false, reason: 'already_driving' } }
  const fake = await startFakeGame(game)
  const created = []
  const host = startHost(fake.port, sessionControllerFor(created))

  try {
    const text = await host.tools.get('sts2_handoff').execute({}, { agent: drivingAgent().agent })
    assert.match(text, /already_driving/)
    assert.equal(created.length, 0)
  } finally {
    host.dispose()
    await fake.close()
  }
})
