/**
 * Line-delimited JSON client for the AiTeammate external-agent bridge.
 *
 * Wire format (one JSON object per line, UTF-8):
 *   → {"id":1,"token":"optional","call":"sts2_state","args":{}}
 *   ← {"id":1,"ok":true,"result":{"text":"..."}}
 *   ← {"id":1,"ok":false,"error":"..."}
 *
 * The client is dependency-free so it can be unit-tested without the harness.
 */

import net from 'node:net'

export class BridgeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeError'
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 4000

export class Bridge {
  constructor(config = {}) {
    this.host = config.host || '127.0.0.1'
    this.port = config.port || 26333
    this.token = config.token || ''
    this.requestTimeoutMs = config.requestTimeoutMs || 60000
    this.connectTimeoutMs = config.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
    this.socket = null
    this.buffer = ''
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any, cleanup: Function}>} */
    this.pending = new Map()
    this.nextId = 1
    this.connecting = null
    /** Connection-level notifier for status surfaces; safe to omit. */
    this.onStatus = typeof config.onStatus === 'function' ? config.onStatus : () => {}
    /** Request-level notifier (`method`), used to tell real traffic from passive polling. */
    this.onRequest = typeof config.onRequest === 'function' ? config.onRequest : () => {}
    /** Last connection failure; cleared by the next successful connect. */
    this.lastError = ''
  }

  /** Whether a live socket to the game bridge is attached. */
  isConnected() {
    return this.socket !== null && this.socket.destroyed === false
  }

  /** Report a connection transition without letting a listener break the socket. */
  notifyStatus() {
    try {
      this.onStatus()
    } catch {
      /* a status surface must never break the transport */
    }
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new BridgeError(
          `Could not connect to the game bridge at ${this.host}:${this.port} in time. ` +
          'Start Slay the Spire 2 and enable Settings → Mod Settings → AI Teammate → External Agent (dsh).'
        ))
      }, this.connectTimeoutMs)

      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.buffer = ''
        this.lastError = ''
        resolve()
        this.notifyStatus()
      })

      socket.once('error', (error) => {
        clearTimeout(timer)
        this.lastError = error.message
        reject(new BridgeError(
          `Could not connect to the game bridge at ${this.host}:${this.port} (${error.message}). ` +
          'Enable Settings → Mod Settings → AI Teammate → External Agent (dsh) and check the port.'
        ))
        this.notifyStatus()
      })

      socket.on('data', (chunk) => this.onData(chunk))
      socket.on('close', () => this.onClose())
      socket.on('error', () => { /* surfaced through close / the pending calls */ })
    }).finally(() => {
      this.connecting = null
    })

    return this.connecting
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8')
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue

      let message
      try { message = JSON.parse(line) } catch { continue }

      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.cleanup()

      if (message.ok) {
        entry.resolve(message.result ?? { text: '' })
      } else {
        entry.reject(new BridgeError(message.error || 'The game bridge rejected the call.'))
      }
    }
  }

  onClose() {
    const error = new BridgeError('The game bridge disconnected. Is the game still running?')
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.cleanup()
      entry.reject(error)
    }
    this.pending.clear()
    this.socket = null
    this.buffer = ''
    // A closed socket says nothing about why the connect failed earlier, so the
    // status surface must stop reporting a stale error.
    this.lastError = ''
    this.notifyStatus()
  }

  async call(method, args = {}, options = {}) {
    const signal = options.signal
    if (signal?.aborted) throw new BridgeError('Tool call was cancelled.')

    try {
      this.onRequest(method)
    } catch {
      /* a notifier must never break the transport */
    }

    await this.connect()
    if (signal?.aborted) throw new BridgeError('Tool call was cancelled.')
    if (!this.socket) throw new BridgeError('The game bridge is not connected.')

    const id = this.nextId++
    const payload = { id, call: method, args: args ?? {} }
    if (this.token) payload.token = this.token
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs

    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!signal) return
        signal.removeEventListener('abort', onAbort)
        const entry = this.pending.get(id)
        if (entry) {
          this.pending.delete(id)
          clearTimeout(entry.timer)
          reject(new BridgeError('Tool call was cancelled.'))
        }
      }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(new BridgeError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s.`))
      }, timeoutMs)

      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      this.pending.set(id, {
        resolve,
        reject: (error) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
        cleanup: () => {
          if (signal) signal.removeEventListener('abort', onAbort)
        },
      })

      try {
        this.socket.write(JSON.stringify(payload) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(new BridgeError(`Failed to send the request to the game: ${error.message}`))
      }
    })
  }

  dispose() {
    const socket = this.socket
    this.onClose()
    try { socket?.destroy() } catch { /* already gone */ }
    this.socket = null
  }
}
