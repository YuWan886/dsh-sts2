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
}

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
  return {
    host: String(read('host') || DEFAULT_CONFIG.host),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    token: String(read('token') ?? ''),
    autoPlayPollMs: Number.isFinite(poll) ? Math.min(Math.max(poll, 200), 5000) : DEFAULT_CONFIG.autoPlayPollMs,
    requestTimeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 1000), 120000) : DEFAULT_CONFIG.requestTimeoutMs,
  }
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

    start(agent) {
      this.stop()
      this.agent = agent
      this.lastToken = ''
      this.lastPromptAt = 0
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
        if (state.phase === 'game_over' || state.phase === 'no_run') {
          this.stop()
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
          source: { kind: 'plugin', plugin: 'sts2' },
        }))
      } catch {
        // The game may be closed, still loading, or between rooms; try again next tick.
      } finally {
        this.busy = false
      }
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

    return () => {
      clearTimeout(probe)
      clearInterval(retryTimer)
      autoplay.stop()
      bridge.dispose()
    }
  }, 'sts2.bridge')

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === autoplay.agent) autoplay.stop()
  })

  // ---- Read tools ---------------------------------------------------------

  async function connectionReport(signal, timeoutMs) {
    try {
      const hello = JSON.parse((await bridge.call('sts2_hello', {}, { signal, timeoutMs })).text)
      let summary = 'no run in progress'
      let phase = 'none'
      let actionable = false
      let controlled = 'none'
      let decision = ''
      try {
        const state = JSON.parse((await bridge.call('sts2_state', {}, { signal, timeoutMs })).text)
        phase = state.phase ?? 'unknown'
        actionable = state.actionable === true
        controlled = state.controlled?.kind ?? (state.phase === 'ai_decision' || state.phase === 'ai_busy' ? 'ai' : 'local')
        decision = state.decision ? `${state.decision.kind} (${state.decision.id})` : ''
        if (state.run) {
          const run = state.run
          summary = `${run.character ?? '?'}, act ${run.act}, floor ${run.floor}, ` +
            `HP ${run.hp}/${run.max_hp}, ${run.gold} gold`
        } else if (state.menu) {
          summary = `main menu (${state.menu.characters?.length ?? 0} characters, ` +
            `continue: ${state.menu.can_continue ? 'yes' : 'no'})`
        }
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
    'event (including advancing the intro dialogue), shop entry, card bundle, or a crystal-sphere cell/tool. ' +
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
      'when the player asks you to take over the game.',
    parameters: {
      enabled: { type: 'boolean', required: true, description: 'true to keep playing automatically, false to stop.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 10000,
    async execute(args, exec) {
      if (!args.enabled) {
        autoplay.stop()
        return 'Autoplay is off. The player is in control again.'
      }
      if (!exec.agent) return 'Autoplay needs an agent context; call this tool from a normal session.'
      autoplay.start(exec.agent)
      const report = await connectionReport(exec.signal, 4000)
      if (!report.startsWith('CONNECTED')) {
        return 'Autoplay is on, but the game is not reachable yet; I will keep retrying.\n' + report
      }
      return 'Autoplay is on. ' + report +
        '\nI will queue the current state whenever the game needs input. Start by reading sts2_state.'
    },
  }))
}
