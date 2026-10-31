/**
 * Chat relay: player lines in the in-game chat panel are injected into the bound conversation,
 * and the model answers with sts2_chat_send.
 *
 * The game routes chat to dsh only while the plugin is polling, so these tests pin the two things
 * that make that safe: polling starts when a conversation touches the game (not before), and the
 * injected block carries the seq the model must answer with.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

const mod = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  return false
}

/** A fake game bridge that answers state/hello and serves one chat line. */
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
        else if (request.call === 'sts2_hello') {
          answer(JSON.stringify({ game_version: '0.111.0', bridge_version: 'test', allow_actions: true, chat: true }))
        } else if (request.call === 'sts2_chat_poll') {
          const messages = game.chatMessages.slice()
          game.chatMessages.length = 0
          answer(JSON.stringify({ seq: game.chatSeq, messages }))
        } else if (request.call === 'sts2_chat_send') {
          answer('Posted to the in-game chat panel as TestBot.')
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

function runState() {
  return {
    phase: 'combat',
    actionable: true,
    token: 't1',
    run: { character: 'Ironclad', act: 1, floor: 3, hp: 40, max_hp: 80, gold: 99 },
  }
}

function boundAgent(id = 'driver') {
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

function startHost(port) {
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
    get() {
      return undefined
    },
  }, {
    host: '127.0.0.1',
    port,
    autoPlayPollMs: 200,
    takeoverPollMs: 1000,
    autoTakeover: false,
    chatPollMs: 120,
  })

  const disposers = effects.map((build) => build()).filter((dispose) => typeof dispose === 'function')
  return {
    tools,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

test('forwards a player chat line into the conversation that used a tool', async () => {
  const game = {
    state: runState(),
    chatSeq: 1,
    chatMessages: [{ seq: 1, from: 'YuWan', text: '先打左边那个', kind: 'player' }],
  }
  const fake = await startFakeGame(game)
  const agent = boundAgent()
  const host = startHost(fake.port)

  try {
    // Any tool call binds the conversation; no autoplay is needed for chat.
    await host.tools.get('sts2_state').execute({}, { agent: agent.agent })

    assert.ok(await waitFor(() => agent.prompts.length > 0), 'the chat line was injected')
    const text = agent.prompts[0].content[0].text
    assert.match(text, /<sts2_chat>/)
    assert.match(text, /YuWan: 先打左边那个/)
    assert.match(text, /reply_to/)
    assert.equal(fake.callsTo('sts2_chat_poll')[0].args.after_seq, 0)
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('the chat poll does not repeat an already delivered line', async () => {
  const game = {
    state: runState(),
    chatSeq: 7,
    chatMessages: [{ seq: 7, from: 'YuWan', text: 'grab the potion', kind: 'player' }],
  }
  const fake = await startFakeGame(game)
  const agent = boundAgent()
  const host = startHost(fake.port)

  try {
    await host.tools.get('sts2_state').execute({}, { agent: agent.agent })
    assert.ok(await waitFor(() => agent.prompts.length === 1))

    await sleep(400)
    assert.equal(agent.prompts.length, 1, 'the same line is not injected twice')
    const polls = fake.callsTo('sts2_chat_poll')
    assert.ok(polls.length >= 2, 'the relay keeps polling')
    assert.ok(polls.at(-1).args.after_seq >= 7, 'the cursor advanced to the delivered seq')
  } finally {
    host.dispose()
    await fake.close()
  }
})

test('sts2_chat_send forwards text, reply_to and directives', async () => {
  const game = { state: runState(), chatSeq: 0, chatMessages: [] }
  const fake = await startFakeGame(game)
  const host = startHost(fake.port)

  try {
    const tool = host.tools.get('sts2_chat_send')
    assert.ok(tool, 'the tool is registered')

    const text = await tool.execute({
      text: '行，先秒左边',
      reply_to: 3,
      directives: [{ type: 'focus_target', accepted: true, summary: 'focus the left one' }],
    }, { agent: boundAgent().agent })

    assert.match(text, /chat panel/i)
    const sent = fake.callsTo('sts2_chat_send')[0]
    assert.equal(sent.args.text, '行，先秒左边')
    assert.equal(sent.args.reply_to, 3)
    assert.equal(sent.args.directives[0].type, 'focus_target')
  } finally {
    host.dispose()
    await fake.close()
  }
})
