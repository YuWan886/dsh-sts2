/**
 * dsh-sts2 — DeepSeek Harness plugin for Slay the Spire 2.
 *
 * Registers native `sts2_*` tools that talk to the AiTeammate external-agent bridge
 * (127.0.0.1 TCP, one JSON object per line) and lets the agent keep playing on its own
 * by queuing follow-up messages whenever the game is waiting for input.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import { Bridge } from './lib/bridge.js'

/**
 * Schemastery is optional at runtime: it is what turns this plugin's config into
 * a Host settings form, but the tools keep working from the profile config alone
 * when it cannot be resolved.
 */
let Schema = null
try {
  const schemastery = await import('@deepseek-ai/schemastery')
  Schema = schemastery.default ?? schemastery.Schema ?? null
} catch {
  Schema = null
}

export const name = 'sts2'
// The tools are the only hard dependency. Settings are optional: a profile that
// composes no settings service still loads every tool.
export const inject = ['tools']

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 26333,
  token: '',
  autoPlayPollMs: 700,
  requestTimeoutMs: 60000,
  autoTakeover: true,
  takeoverPollMs: 4000,
  takeoverCwd: '',
}

/**
 * How long this process must be silent before the take-over poller treats the run as unmanaged.
 *
 * The game only offers an invitation after 15 s without a single non-passive request
 * (`AgentTakeoverInvite.DrivingIdleSeconds`), so a loop that is really driving the run answers
 * every poll with `already_driving` anyway. Staying quiet a little before that keeps the poller
 * from burning a claim (3 per run, 60 s each) on a driver that is merely mid-turn.
 */
const DRIVER_QUIET_MS = 10_000

/**
 * A driver that is still "running a turn" is not stolen from until it has been silent this long:
 * its in-flight turn would otherwise keep acting on the game right after the hand-over.
 */
const STUCK_DRIVER_MS = 90_000

/**
 * Producer identity for every message this plugin injects.
 *
 * The session format has no catch-all `plugin` source kind: each producer names itself, and the
 * v3→v4 migration derives `plugin:<name>` for third-party plugins — the same kind our historical
 * rows already carry. Writing the retired `{kind:'plugin'}` shape makes the stored session fail
 * to load with "format v4 message requires a producer-owned source kind".
 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin:sts2' })

/**
 * Mark one field editable without restarting the plugin.
 *
 * dsh's own schemastery build carries `Schema.prototype.volatile()`, but a
 * plugin may resolve a plain npm copy of the same version, so mark the node the
 * way the Host reads it (`meta.volatile`) and use the method when it exists.
 */
function volatileField(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  schema.meta = { ...(schema.meta ?? {}), volatile: true }
  return schema
}

/**
 * The schema the Host renders as this plugin's settings form.
 *
 * dsh 0.2.x derives a settings namespace from the plugin's own `Config`, keyed by
 * the profile entry id (`sts2`); only fields marked volatile are exposed to a
 * browser card and may be rewritten without restarting the plugin. The endpoint
 * is exactly that kind of value — the bridge re-points itself when it moves.
 */
export const Config =
  Schema === null
    ? undefined
    : Schema.object({
        host: volatileField(Schema.string().default(DEFAULT_CONFIG.host)),
        port: volatileField(Schema.number().default(DEFAULT_CONFIG.port)),
        token: volatileField(Schema.string().default(DEFAULT_CONFIG.token)),
        autoPlayPollMs: Schema.number().default(DEFAULT_CONFIG.autoPlayPollMs),
        requestTimeoutMs: Schema.number().default(DEFAULT_CONFIG.requestTimeoutMs),
        autoTakeover: Schema.boolean().default(DEFAULT_CONFIG.autoTakeover),
        takeoverPollMs: Schema.number().default(DEFAULT_CONFIG.takeoverPollMs),
        takeoverCwd: volatileField(Schema.string().default(DEFAULT_CONFIG.takeoverCwd)),
      })

/**
 * Read one config field: `volatile()` fields arrive as live values carrying
 * `get()`, ordinary fields arrive as plain values, and both must work.
 */
function readConfigValue(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const live = value.get()
      return live === undefined ? fallback : live
    } catch {
      return fallback
    }
  }
  return value === undefined ? fallback : value
}

export function normalizeConfig(config) {
  const read = (key) => readConfigValue(config?.[key], DEFAULT_CONFIG[key])
  const port = Number(read('port'))
  const poll = Number(read('autoPlayPollMs'))
  const timeout = Number(read('requestTimeoutMs'))
  const takeoverPoll = Number(read('takeoverPollMs'))
  return {
    host: String(read('host') || DEFAULT_CONFIG.host),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    token: String(read('token') ?? ''),
    autoPlayPollMs: Number.isFinite(poll) ? Math.min(Math.max(poll, 200), 5000) : DEFAULT_CONFIG.autoPlayPollMs,
    requestTimeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 1000), 120000) : DEFAULT_CONFIG.requestTimeoutMs,
    autoTakeover: read('autoTakeover') !== false,
    takeoverPollMs: Number.isFinite(takeoverPoll)
      ? Math.min(Math.max(takeoverPoll, 1000), 30000)
      : DEFAULT_CONFIG.takeoverPollMs,
    takeoverCwd: String(read('takeoverCwd') ?? '').trim(),
  }
}

// ---------------------------------------------------------------------------
// Auto takeover
// ---------------------------------------------------------------------------

/**
 * Open a conversation inside the running dsh and hand the game to it.
 *
 * `createSessionInProcess()` goes through the same Session Controller the Web UI uses when the
 * player clicks "new chat", so the result is an ordinary conversation: it shows up in the
 * workspace, it streams live, and the player can start typing in it at any point. Profiles that
 * expose neither that controller nor the agent service (headless, ACP) cannot be taken over
 * programmatically and fail soft, which is why the caller treats that message as "unsupported"
 * instead of retrying.
 */
async function openTakeoverConversation(ctx, cfg, invite, logger) {
  const cwd = String(cfg.takeoverCwd || invite.workspace || '').trim()
  if (!cwd) throw new Error('no workspace for the take-over conversation')

  const agent = await createSessionInProcess(ctx, cwd)

  // Group the conversation under the workspace so it sits where the player expects it.
  try {
    const registry = ctx.get('workspaceRegistry', false)
    if (typeof registry?.create === 'function') {
      const workspace = await registry.create(cwd)
      await workspace.attachSession(agent.id)
    }
  } catch (error) {
    logger?.info?.(`take-over workspace attach skipped: ${String(error)}`)
  }

  const text = String(invite.prompt ?? '').trim() ||
    'The game is waiting for you. Use the sts2_* tools to take over the AI teammate.'
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: PLUGIN_SOURCE,
  }))

  return agent
}

/**
 * Create an ordinary conversation in this dsh process.
 *
 * Preferred path is the Session Controller the Web UI itself calls, because it resolves the
 * session's default model, preset and provenance exactly like a click on "new chat". A build that
 * exposes only the lower-level `agents` service still works through `agents.create()` with the
 * remembered default route.
 */
async function createSessionInProcess(ctx, cwd) {
  const controller = ctx.get('sessionController', false)
  if (typeof controller?.agents?.createSession === 'function') {
    const created = await controller.agents.createSession({ cwd, reusable: () => false })
    if (created?.agent) return created.agent
  }

  const agents = ctx.get('agents', false)
  if (typeof agents?.create !== 'function')
    throw new Error('this dsh build has no session controller')

  const selection = ctx.get('agentDefaultModel', false)?.currentSelection?.()
  const sessionId = `session-${globalThis.crypto.randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    ...(selection?.provider && selection?.model
      ? { agentOptions: { provider: selection.provider, model: selection.model } }
      : {}),
  })
  if (!handle?.agent)
    throw new Error('session creation returned no agent')
  return handle.agent
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SUBJECTS = ['pile', 'relics', 'potions', 'player', 'run', 'map', 'deck_stats', 'card']
const PILES = ['hand', 'draw', 'discard', 'exhaust', 'deck']

function textTool(toolName, description, parameters, options = {}) {
  return defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: options.timeoutMs ?? 60000,
    async execute(args, exec) {
      const result = await options.bridge.call(toolName, args, {
        signal: exec.signal,
        timeoutMs: options.timeoutMs ?? 60000,
      })
      return result.text ?? ''
    },
  })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const bridge = new Bridge(config)
  const pollMs = config.autoPlayPollMs
  const logger = ctx.logger?.('sts2')

  logger?.info?.(`dsh-sts2 loaded; game bridge target ${config.host}:${config.port}`)

  // ---- Live settings --------------------------------------------------------
  // The Host settings form (插件 → dsh-sts2 → sts2 → 配置) writes the volatile
  // endpoint fields straight into this entry's config without restarting the
  // fiber, so re-read them and re-point the bridge when they actually move.
  // Ordinary fields (poll interval, request timeout) apply on the next load.
  let helloSummary = ''

  /**
   * The entry config, read live: when a volatile field is rewritten dsh either
   * patches the resolved config in place or swaps the fiber's config object, so
   * prefer the fiber's current value over the reference apply() received.
   */
  function liveConfig() {
    try {
      return ctx.fiber?.config ?? rawConfig
    } catch {
      return rawConfig
    }
  }

  /** Re-read the entry config; true when the bridge endpoint changed. */
  function syncEndpoint() {
    const next = normalizeConfig(liveConfig())
    if (next.host === bridge.host && next.port === bridge.port && next.token === bridge.token) return false
    bridge.host = next.host
    bridge.port = next.port
    bridge.token = next.token
    bridge.requestTimeoutMs = next.requestTimeoutMs
    helloSummary = ''
    try {
      bridge.dispose()
    } catch {
      /* already gone */
    }
    logger?.info?.(`dsh-sts2 endpoint changed; targeting ${next.host}:${next.port}`)
    return true
  }

  /** Current endpoint, resolved live for the connection report. */
  function endpoint() {
    const live = normalizeConfig(liveConfig())
    return `${live.host}:${live.port}`
  }

  /** Ask the game who it is, so the report can show versions instead of "connected". */
  async function probeHello() {
    try {
      const hello = JSON.parse((await bridge.call('sts2_hello', {}, { timeoutMs: 4000 })).text)
      helloSummary = `游戏 ${hello.game_version ?? '?'} · 桥接 ${hello.bridge_version ?? '?'} · 操作${
        hello.allow_actions === true ? '允许' : '只读'
      }`
      logger?.info?.(`game bridge ${endpoint()} connected: ${helloSummary}`)
    } catch {
      helloSummary = ''
    }
  }

  // While the game is closed, keep retrying cheaply so the bridge comes up by
  // itself as soon as the game (or a corrected endpoint) appears.
  const retryTimer = setInterval(() => {
    const changed = syncEndpoint()
    if (bridge.isConnected() && !changed) return
    void bridge
      .connect()
      .then(() => probeHello())
      .catch(() => {})
  }, 5000)
  retryTimer.unref?.()

  // ---- Autoplay -----------------------------------------------------------

  const autoplay = {
    agent: null,
    timer: null,
    busy: false,
    lastToken: '',
    lastPromptAt: 0,
    /** Last moment this process spoke to the game; drives the take-over "is anyone driving?" test. */
    lastActivityAt: 0,

    start(agent) {
      this.stop()
      this.agent = agent
      this.lastToken = ''
      this.lastPromptAt = 0
      this.lastActivityAt = Date.now()
      this.timer = setInterval(() => { void this.tick() }, pollMs)
      void this.tick()
    },

    stop() {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.agent = null
      this.busy = false
      this.lastToken = ''
      this.lastPromptAt = 0
    },

    async tick() {
      if (!this.agent || this.busy) return
      const agent = this.agent
      if (agent.status !== 'idle') return

      this.busy = true
      try {
        const result = await bridge.call('sts2_state', {}, { timeoutMs: 8000 })
        const state = JSON.parse(result.text)
        // Leaving the run (game over, back at the main menu, save loaded away) ends the loop.
        // Polling an empty menu keeps the bridge "busy" for the game and would hide both the next
        // take-over invitation and the silence fallback, so stop instead of ticking forever.
        if (state.phase === 'game_over' || state.phase === 'no_run' || state.phase === 'menu') {
          this.stop()
          logger?.info?.(`autoplay stopped (${state.phase})`)
          return
        }
        if (!state.actionable) return

        const now = Date.now()
        const changed = state.token !== this.lastToken
        // Re-prompt the same state slowly if the model went idle without acting.
        if (!changed && now - this.lastPromptAt < 15000) return

        this.lastToken = state.token
        this.lastPromptAt = now
        const hint = state.phase === 'ai_decision'
          ? 'A decision is waiting: answer it with sts2_decide. ' +
            'decision.prompt / decision.options hold the exact task and JSON shape.'
          : 'Continue playing with the sts2_* tools. Current state:'
        const prompt =
          '<sts2_autoplay>\n' +
          `The game is waiting for you (phase: ${state.phase}, token: ${state.token}).\n` +
          hint + '\n' +
          result.text + '\n' +
          '</sts2_autoplay>'

        agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: PLUGIN_SOURCE,
        }))
      } catch {
        // The game may be closed, still loading, or between rooms; try again next tick.
      } finally {
        this.busy = false
      }
    },
  }

  // Traffic from this process is what makes the game treat the run as driven (`ClientIdleSeconds`).
  // Track it so the take-over poller can tell a live driver from a loop that went quiet, and keep
  // the poller's own invitation requests out of the count — the game treats them as passive too.
  bridge.onRequest = (method) => {
    if (method !== 'sts2_takeover') autoplay.lastActivityAt = Date.now()
  }

  // ---- Auto takeover ------------------------------------------------------
  // A multiplayer run that has an AI teammate still needs a driver. The game offers an invitation
  // on its bridge (`sts2_takeover`) once nothing has played the run for a while; claiming it opens
  // a real conversation here, in this dsh process and in the configured workspace, so the player no
  // longer has to open a chat and type "play Slay the Spire 2" by hand.
  //
  // Exactly one conversation drives the run. While this process is really driving, the game answers
  // `already_driving` and a claim would only waste one of the three invitations the run allows, so
  // the poller stays quiet as long as the driver is alive. Once that driver goes quiet the
  // invitation is a hand-over instead of a second driver: the fresh conversation is opened first and
  // the stale loop is retired right after it exists. That is also what keeps a forgotten autoplay
  // loop from owning the game for the rest of the process' life.
  const takeover = {
    timer: null,
    busy: false,
    unsupported: false,
    done: new Set(),

    start() {
      if (this.timer) return
      const cfg = normalizeConfig(liveConfig())
      this.timer = setInterval(() => { void this.tick() }, cfg.takeoverPollMs)
      this.timer.unref?.()
    },

    stop() {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.busy = false
    },

    /**
     * Ask the game for the invitation and, when it takes, open the conversation that drives it.
     * Answers `{opened, agent, runToken, reason, error}`; `reason` is the game's refusal
     * (`already_driving`, `warmup`, `claimed`, …) or one of ours (`busy`, `already_opened`).
     */
    async claim() {
      if (this.busy) return { opened: false, reason: 'busy' }

      this.busy = true
      try {
        const cfg = normalizeConfig(liveConfig())
        const result = await bridge.call('sts2_takeover', {}, { timeoutMs: 4000 })
        const invite = JSON.parse(result.text)
        if (invite?.take !== true) return { opened: false, reason: String(invite?.reason ?? 'no_invite') }

        const runToken = String(invite.run_token ?? '')
        if (runToken && this.done.has(runToken)) return { opened: false, reason: 'already_opened' }

        const agent = await openTakeoverConversation(ctx, cfg, invite, logger)
        if (runToken) this.done.add(runToken)
        // The previous loop had already been silent long enough for the game to offer the run, so
        // the fresh conversation is the driver now. Retire it only after the new one exists: a
        // failed creation must not leave the run without anyone playing it.
        if (autoplay.timer) {
          autoplay.stop()
          logger?.info?.('take-over retired the previous autoplay loop')
        }
        logger?.info?.(`take-over conversation ${agent?.id ?? '?'} started for run ${runToken.slice(0, 8) || '?'}`)
        return { opened: true, agent, runToken }
      } catch (error) {
        if (String(error).includes('no session controller')) {
          this.unsupported = true
          logger?.info?.('auto take-over disabled: this dsh build has no session controller')
          return { opened: false, reason: 'unsupported' }
        }
        logger?.warn?.(`take-over skipped: ${String(error)}`)
        return { opened: false, reason: 'error', error }
      } finally {
        this.busy = false
      }
    },

    async tick() {
      const cfg = normalizeConfig(liveConfig())
      if (!cfg.autoTakeover || this.busy || this.unsupported || !bridge.isConnected()) return

      if (autoplay.timer) {
        const quietMs = Date.now() - autoplay.lastActivityAt
        // A live loop answers every invitation with "already_driving"; do not poll while it drives.
        if (quietMs < DRIVER_QUIET_MS) return
        // A conversation in the middle of a turn would keep acting after the hand-over; only take
        // the run away from it once it has been silent long enough to count as dead.
        if (autoplay.agent?.status !== 'idle' && quietMs < STUCK_DRIVER_MS) return
      }

      await this.claim()
    },
  }

  ctx.effect(() => {
    // Probe once on load so the game's settings page shows a connected client even before the
    // first tool call. Failures are expected while the game is closed; calls reconnect on demand.
    const probe = setTimeout(() => {
      void bridge.connect()
        .then(() => probeHello())
        .then(() => logger?.info?.(`connected to the game bridge at ${bridge.host}:${bridge.port}`))
        .catch(() => { /* game not running yet */ })
    }, 1500)

    takeover.start()

    return () => {
      clearTimeout(probe)
      clearInterval(retryTimer)
      takeover.stop()
      autoplay.stop()
      bridge.dispose()
    }
  }, 'sts2.bridge')

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === autoplay.agent) autoplay.stop()
  })

  // ---- Read tools ---------------------------------------------------------

  /** Read the snapshot once; throws when the game cannot be reached or refused. */
  async function readState(signal, timeoutMs = 8000) {
    const result = await bridge.call('sts2_state', {}, { signal, timeoutMs })
    return JSON.parse(result.text)
  }

  /** One line about where the player is, shared by the status report and the autoplay tool. */
  function runSummary(state) {
    if (state?.run) {
      const run = state.run
      return `${run.character ?? '?'}, act ${run.act}, floor ${run.floor}, ` +
        `HP ${run.hp}/${run.max_hp}, ${run.gold} gold`
    }
    if (state?.menu) {
      return `main menu (${state.menu.characters?.length ?? 0} characters, ` +
        `continue: ${state.menu.can_continue ? 'yes' : 'no'})`
    }
    return 'no run in progress'
  }

  async function connectionReport(signal, timeoutMs) {
    try {
      const hello = JSON.parse((await bridge.call('sts2_hello', {}, { signal, timeoutMs })).text)
      let summary = 'no run in progress'
      let phase = 'none'
      let actionable = false
      let controlled = 'none'
      let decision = ''
      try {
        const state = await readState(signal, timeoutMs)
        phase = state.phase ?? 'unknown'
        actionable = state.actionable === true
        controlled = state.controlled?.kind ?? (state.phase === 'ai_decision' || state.phase === 'ai_busy' ? 'ai' : 'local')
        decision = state.decision ? `${state.decision.kind} (${state.decision.id})` : ''
        summary = runSummary(state)
      } catch (error) {
        summary = `state unavailable: ${error.message}`
      }
      return [
        'CONNECTED to Slay the Spire 2.',
        `  endpoint: ${endpoint()}`,
        `  bridge: ${hello.bridge_version ?? 'unknown'} (allow_actions: ${hello.allow_actions === true ? 'yes' : 'no'})`,
        `  run: ${summary}`,
        `  phase: ${phase} (actionable: ${actionable ? 'yes' : 'no'})`,
        `  controlled: ${controlled}${decision ? `, pending decision: ${decision}` : ''}`,
        '  modes: controlled=local → play with the sts2_* action tools; ' +
        'controlled=ai → answer with sts2_decide.',
      ].join('\n')
    } catch (error) {
      return [
        'NOT CONNECTED to Slay the Spire 2.',
        `  endpoint: ${endpoint()}`,
        `  reason: ${error.message}`,
        '',
        'Checklist:',
        '  1. Slay the Spire 2 is running.',
        '  2. Settings → Mod Settings → AI Teammate → External Agent (dsh) is turned on.',
        '  3. The bridge port here matches the mod setting (default 26333).',
        '  4. The token matches, if one is set on either side.',
        '  5. The AiTeammate mod is loaded in the game.',
      ].join('\n')
    }
  }

  ctx.tools.register(defineTool({
    name: 'sts2_status',
    description:
      'Check whether dsh is connected to Slay the Spire 2. Call this when the player asks whether the ' +
      'game is connected, or before starting a session. Returns CONNECTED / NOT CONNECTED with the ' +
      'endpoint, whether actions are allowed, and a one-line run summary.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    async execute(_args, exec) {
      return await connectionReport(exec.signal, 5000)
    },
  }))

  ctx.tools.register(textTool(
    'sts2_state',
    'Return the current Slay the Spire 2 state: phase, run, combat, options and a token. ' +
    'Call this first; pass the returned token to sts2_wait.',
    {},
    { bridge, timeoutMs: 15000 },
  ))

  ctx.tools.register(textTool(
    'sts2_wait',
    'Block until the game needs your input (or the state changes). The primary autoplay loop: ' +
    'after each action, call sts2_wait with the token from the previous result. ' +
    'Returns the new state, or the same state with wait_timed_out=true after the timeout.',
    {
      after_token: { type: 'string', description: 'Token from the previous result. Omit to return as soon as the game is actionable.' },
      timeout_seconds: { type: 'integer', description: 'How long to wait (1-50, default 25).' },
    },
    { bridge, timeoutMs: 60000 },
  ))

  ctx.tools.register(textTool(
    'sts2_read',
    'Read deeper game information on demand: pile contents, relics, potions, player status, run summary, map, deck stats or one card. ' +
    'Draw order is never exposed.',
    {
      subject: { type: 'string', required: true, enum: SUBJECTS, description: 'What to read.' },
      pile: { type: 'string', enum: PILES, description: 'Pile for subject=pile.' },
      card: { type: 'string', description: 'Card name for subject=card.' },
      player: { type: 'string', description: 'Optional player name/id; defaults to yourself.' },
      detail: { type: 'string', enum: ['brief', 'full'], description: 'Pile detail level.' },
    },
    { bridge, timeoutMs: 20000 },
  ))

  ctx.tools.register(textTool(
    'sts2_set_nickname',
    'Change the AI teammate\'s display nickname (nameplate, chat, prompts and run history). ' +
    'Pass an empty name to go back to the active personality\'s name. Works in read-only mode too.',
    {
      name: { type: 'string', required: true, description: 'New nickname, at most 24 characters.' },
    },
    { bridge, timeoutMs: 15000 },
  ))

  ctx.tools.register(defineTool({
    name: 'sts2_screenshot',
    description: 'Capture the current game screen as an image (requires the screenshot setting and a vision-capable model).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          image: { type: 'json' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const blocks = []
        if (value.image) blocks.push({ type: 'image', attachment: value.image })
        blocks.push({ type: 'text', text: value.text })
        return blocks
      },
    },
    timeoutMs: 20000,
    async execute(_args, exec) {
      const result = await bridge.call('sts2_screenshot', {}, { signal: exec.signal, timeoutMs: 15000 })
      if (!result.image) return { text: result.text ?? '' }

      const attachments = ctx.get('attachments')
      if (!attachments) {
        return { text: `${result.text ?? ''}\n(The image was captured but the attachments service is not loaded.)` }
      }

      const [ref] = await admitEncodedImages(attachments, [{
        mediaType: result.mimeType || 'image/jpeg',
        data: result.image,
        name: 'sts2.jpg',
      }])
      return { text: result.text ?? '', image: ref }
    },
  }))

  // ---- Action tools -------------------------------------------------------

  ctx.tools.register(textTool(
    'sts2_decide',
    'Answer the decision the game is waiting for (phase=ai_decision). It is either the AI player\'s ' +
    'decision or a hand_select card choice for the local player you control (e.g. an upgrade pick). ' +
    'The state carries decision.kind, decision.prompt and decision.options: prompt is the exact task ' +
    'and the JSON shape it expects. Pass that JSON object as decision. While a decision is pending ' +
    'the other action tools are refused.',
    {
      decision: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'The JSON decision object the prompt asked for.',
      },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_start_run',
    'Start a new singleplayer run from the main menu (phase=menu). Character ids come from ' +
    'state.menu.characters; ascension is capped by state.menu.max_ascension. Omit character for a random one.',
    {
      character: { type: 'string', description: 'Character id or name; random when omitted.' },
      ascension: { type: 'integer', description: 'Ascension level (0..menu.max_ascension).' },
      seed: { type: 'string', description: 'Optional seed.' },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_continue_run',
    'Resume the saved singleplayer run (phase=menu with menu.can_continue=true).',
    {},
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_pause',
    'Pause the game: opens the pause menu and holds the AI teammate automation. Call sts2_resume ' +
    'to continue. The paused state reports phase="paused" and is not actionable.',
    {},
    { bridge, timeoutMs: 20000 },
  ))

  ctx.tools.register(textTool(
    'sts2_resume',
    'Resume from the pause menu (closes it and releases the automation hold).',
    {},
    { bridge, timeoutMs: 20000 },
  ))

  ctx.tools.register(textTool(
    'sts2_save',
    'Save the current run now (singleplayer or multiplayer host only). The game also autosaves at ' +
    'checkpoints; use this before risky decisions or before sts2_quit_to_menu.',
    {},
    { bridge, timeoutMs: 20000 },
  ))

  ctx.tools.register(textTool(
    'sts2_quit_to_menu',
    "Save the run and return to the main menu, like the pause menu's Save and Quit.",
    {},
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_abandon',
    'Abandon the run in progress and return to the main menu. This deletes the current run save; ' +
    'only the singleplayer session or the multiplayer host may do it.',
    {},
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_play_card',
    'Play a card during your combat turn (only when sts2_state reports controlled.kind=local). ' +
    'Use the hand index or the card name from sts2_state. Returns the updated state; if a card opens ' +
    'a selection screen, the new phase shows it. wait (default true) blocks until the game is ' +
    'actionable again, so you usually do NOT need a follow-up sts2_wait. For several cards use ' +
    'sts2_play_cards instead — one call per turn instead of one call per card.',
    {
      card: { type: 'string', required: true, description: 'Hand index (0-based) or card name.' },
      target: { type: 'string', description: 'Enemy index/name, or "self". Defaults to the first alive enemy for attacks.' },
      wait: { type: 'boolean', description: 'Block until the game is actionable again (default true).' },
      wait_seconds: { type: 'integer', description: 'How long to wait for that state (default 20, max 50).' },
    },
    { bridge, timeoutMs: 60000 },
  ))

  ctx.tools.register(textTool(
    'sts2_play_cards',
    'Play a whole list of cards in ONE call (the fast path for combat turns), optionally ending the turn. ' +
    'Each entry is {"card":"<name|hand index>","target":"<enemy>"} or a plain card name. Steps run in ' +
    'order and each one re-resolves the hand, so names are more robust than indices. It stops at the ' +
    'first failing step and at any card-selection screen, and the returned steps[] says exactly what ' +
    'happened — nothing is played blind. Prefer this over repeated sts2_play_card calls.',
    {
      cards: {
        type: 'array',
        required: true,
        description: 'Ordered cards to play: {"card","target"} objects or plain card names.',
      },
      end_turn: { type: 'boolean', description: 'End the turn after the last card (default false).' },
      wait: { type: 'boolean', description: 'Block until the game is actionable again (default true).' },
      wait_seconds: { type: 'integer', description: 'How long to wait for that state (default 20, max 50).' },
    },
    { bridge, timeoutMs: 60000 },
  ))

  ctx.tools.register(textTool(
    'sts2_claim_rewards',
    'Claim every reward on a reward screen that needs no decision (gold / potion / relic) in one call, ' +
    'stopping before card rewards so you can pick them with sts2_choose. Replaces the old ' +
    'claim-gold → claim-potion → claim-card sequence of separate calls.',
    {},
    { bridge, timeoutMs: 40000 },
  ))

  ctx.tools.register(textTool(
    'sts2_use_potion',
    'Use a potion. potion is a slot index or a potion name from sts2_state. AnyTime potions ' +
    '(healing, gold, ...) also work outside combat; CombatOnly ones do not.',
    {
      potion: { type: 'string', required: true, description: 'Potion index or name.' },
      target: { type: 'string', description: 'Optional target (enemy index/name or "self").' },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_discard_potion',
    'Throw a potion away without using it. potion is a slot index or a potion name from sts2_state.',
    {
      potion: { type: 'string', required: true, description: 'Potion index or name.' },
    },
    { bridge, timeoutMs: 20000 },
  ))

  ctx.tools.register(textTool(
    'sts2_end_turn',
    'End your combat turn. By default it waits for the enemy turn to finish and returns your next ' +
    'turn, so no follow-up sts2_wait is needed. wait:false returns immediately.',
    {
      wait: { type: 'boolean', description: 'Block until your next turn starts (default true).' },
      wait_seconds: { type: 'integer', description: 'How long to wait (default 20, max 50).' },
    },
    { bridge, timeoutMs: 60000 },
  ))

  ctx.tools.register(textTool(
    'sts2_choose',
    'Choose an option in the current screen: map node, reward, card reward, card choice, relic, rest site, ' +
    'event (including advancing the intro dialogue), shop entry, card bundle, a crystal-sphere cell/tool, ' +
    'or a target in phase=target_select (rest-site MEND and similar target pickers; the last index cancels). ' +
    'The option indices come from sts2_state. Use skip=true to skip a card/relic reward.',
    {
      index: { type: 'integer', description: 'Option index from sts2_state.options.' },
      skip: { type: 'boolean', description: 'Skip instead of choosing (card reward / card choice / relic screen).' },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_select_cards',
    'Submit a card selection on a card-selection screen (deck removal, upgrade, transform, enchant, in-combat picks). ' +
    'Pass all indices at once; the game expects the complete selection.',
    {
      indices: {
        type: 'array',
        required: true,
        items: { type: 'integer' },
        description: 'Card option indices from sts2_state.options.',
      },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_proceed',
    'Advance the current screen: leave rewards, skip a card/relic reward, continue an event page, ' +
    'close the shop shelf, leave a room, open a treasure chest, confirm a bundle pick, close the ' +
    'crystal sphere, or advance the game-over screen.',
    {},
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(defineTool({
    name: 'sts2_autoplay',
    description:
      'Turn autonomous play on or off. When on, this plugin wakes you with the current state whenever ' +
      'the game needs input, until the run ends or you turn it off. Call sts2_autoplay with enabled=true ' +
      'when the player asks you to take over the game. It only arms while a run is in progress: from the ' +
      'main menu start or resume a run first. The loop ends by itself when the run ends or the game ' +
      'goes back to the main menu, so call it again after resuming a run. To move the run into a ' +
      'brand-new conversation use sts2_handoff instead of switching autoplay off by hand.',
    parameters: {
      enabled: { type: 'boolean', required: true, description: 'true to keep playing automatically, false to stop.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    async execute(args, exec) {
      if (!args.enabled) {
        autoplay.stop()
        return 'Autoplay is off. The player is in control again.'
      }
      if (!exec.agent) return 'Autoplay needs an agent context; call this tool from a normal session.'

      let state
      try {
        state = await readState(exec.signal, 8000)
      } catch (error) {
        return `Autoplay stays off: the game is not reachable (${error.message}). ` +
          'Start the game (or fix the endpoint) and call sts2_autoplay again.'
      }
      if (!state.run) {
        return `Autoplay stays off: no run is in progress (phase: ${state.phase ?? '?'}). ` +
          'Start a run with sts2_start_run or resume one with sts2_continue_run, then call ' +
          'sts2_autoplay again. Polling the main menu from here would keep the bridge busy for ' +
          'the game and hide the next take-over invitation.'
      }

      autoplay.start(exec.agent)
      return `Autoplay is on: ${runSummary(state)} (phase: ${state.phase ?? '?'}). ` +
        'I will queue the current state whenever the game needs input. Start by reading sts2_state.'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sts2_handoff',
    description:
      'Hand the run over to a brand-new conversation in this dsh process: this conversation stops ' +
      'driving the game and the plugin opens an ordinary conversation (exactly like clicking "new ' +
      'chat") and sends it the take-over prompt. Use it when the player asks to move the game into a ' +
      'fresh conversation, or when this conversation should stop playing while dsh keeps the run ' +
      'going. After a successful hand-over do not act on the game from this conversation any more.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    async execute() {
      autoplay.stop()

      const result = await takeover.claim()
      if (result.opened) {
        return `Handed over to conversation ${result.agent?.id ?? '?'}: it drives the run now. ` +
          'This conversation must stop acting on the game.'
      }

      if (result.reason === 'error' || result.reason === 'unsupported') {
        return `Autoplay is off here, but the new conversation could not be opened: ` +
          `${String(result.error ?? result.reason)}. Keep playing in this conversation and call ` +
          'sts2_autoplay again, or check the dsh log for the take-over failure.'
      }
      if (result.reason === 'busy') {
        return 'Autoplay is off here. A take-over attempt is already in flight; the poller will ' +
          'finish it and open the new conversation.'
      }
      if (result.reason === 'already_opened') {
        return 'Autoplay is off here. A take-over conversation for this run already exists — use ' +
          'that one, or call sts2_autoplay again to keep playing here.'
      }
      return `Autoplay is off here; the game does not offer the run yet (${result.reason}). The ` +
        'poller retries every few seconds and opens the new conversation as soon as the invitation ' +
        'is available — the game waits for about 15 s without traffic before offering it. Keep ' +
        'this conversation off the game in the meantime.'
    },
  }))
}
