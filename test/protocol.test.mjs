import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { Bridge, BridgeError } from '../lib/bridge.js'

/** A minimal fake bridge that records requests and answers through `handler`. */
function startFakeBridge(handler) {
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
        handler(request, socket)
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function reply(socket, payload) {
  socket.write(JSON.stringify(payload) + '\n')
}

test('sends a framed request and resolves the matching response', async () => {
  const fake = await startFakeBridge((request, socket) => {
    reply(socket, { id: request.id, ok: true, result: { text: `{"phase":"combat","token":"abc"}` } })
  })

  try {
    const bridge = new Bridge({ port: fake.port, connectTimeoutMs: 1000 })
    const result = await bridge.call('sts2_state', {})
    assert.equal(result.text, '{"phase":"combat","token":"abc"}')
    assert.deepEqual(fake.requests[0], { id: 1, call: 'sts2_state', args: {} })
    bridge.dispose()
  } finally {
    await fake.close()
  }
})

test('includes the configured token and passes tool arguments through', async () => {
  const fake = await startFakeBridge((request, socket) => {
    reply(socket, { id: request.id, ok: true, result: { text: 'ok' } })
  })

  try {
    const bridge = new Bridge({ port: fake.port, token: 'secret', connectTimeoutMs: 1000 })
    await bridge.call('sts2_play_card', { card: '0', target: '1' })
    assert.equal(fake.requests[0].token, 'secret')
    assert.deepEqual(fake.requests[0].args, { card: '0', target: '1' })
    bridge.dispose()
  } finally {
    await fake.close()
  }
})

test('surfaces bridge errors as BridgeError', async () => {
  const fake = await startFakeBridge((request, socket) => {
    reply(socket, { id: request.id, ok: false, error: 'No run in progress.' })
  })

  try {
    const bridge = new Bridge({ port: fake.port, connectTimeoutMs: 1000 })
    await assert.rejects(() => bridge.call('sts2_state', {}), (error) => {
      assert.ok(error instanceof BridgeError)
      assert.match(error.message, /No run in progress/)
      return true
    })
    bridge.dispose()
  } finally {
    await fake.close()
  }
})

test('handles fragmented and batched response lines', async () => {
  const fake = await startFakeBridge((request, socket) => {
    if (request.call === 'first') {
      // Two lines in one write, with the first line split across chunks.
      const line = JSON.stringify({ id: 1, ok: true, result: { text: 'one' } }) + '\n'
      const second = JSON.stringify({ id: 2, ok: true, result: { text: 'two' } }) + '\n'
      socket.write(line.slice(0, 7))
      setTimeout(() => socket.write(line.slice(7) + second), 10)
    }
  })

  try {
    const bridge = new Bridge({ port: fake.port, connectTimeoutMs: 1000 })
    const first = bridge.call('first', {})
    const second = bridge.call('second', {})
    assert.equal((await first).text, 'one')
    assert.equal((await second).text, 'two')
    bridge.dispose()
  } finally {
    await fake.close()
  }
})

test('rejects pending calls when the game disconnects', async () => {
  const fake = await startFakeBridge((_request, socket) => {
    socket.destroy()
  })

  try {
    const bridge = new Bridge({ port: fake.port, connectTimeoutMs: 1000 })
    await assert.rejects(() => bridge.call('sts2_wait', {}), (error) => {
      assert.ok(error instanceof BridgeError)
      assert.match(error.message, /disconnected|timed out|rejected/i)
      return true
    })
    bridge.dispose()
  } finally {
    await fake.close()
  }
})

test('reports a helpful error when the game bridge is not running', async () => {
  // Reserve a port, then close it so nothing listens there.
  const fake = await startFakeBridge(() => { })
  const port = fake.port
  await fake.close()

  const bridge = new Bridge({ port, connectTimeoutMs: 500 })
  await assert.rejects(() => bridge.call('sts2_state', {}), (error) => {
    assert.ok(error instanceof BridgeError)
    assert.match(error.message, /Could not connect/)
    return true
  })
})

test('cancellation aborts a pending call', async () => {
  const fake = await startFakeBridge(() => { /* deliberately never reply */ })

  try {
    const bridge = new Bridge({ port: fake.port, connectTimeoutMs: 1000 })
    const controller = new AbortController()
    const pending = bridge.call('sts2_wait', {}, { signal: controller.signal })
    controller.abort()
    await assert.rejects(() => pending, /cancelled/i)
    bridge.dispose()
  } finally {
    await fake.close()
  }
})
