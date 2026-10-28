/**
 * dsh-sts2 — DeepSeek Harness plugin for Slay the Spire 2.
 *
 * Registers native `sts2_*` tools that talk to the AiTeammate external-agent bridge
 * (127.0.0.1 TCP, one JSON object per line) and lets the agent keep playing on its own
 * by queuing follow-up messages whenever the game is waiting for input.
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import { Bridge } from './lib/bridge.js'

export const name = 'sts2'
export const inject = ['tools']

export const Config = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().min(1).max(65535).default(26333),
  token: Schema.string().default(''),
  autoPlayPollMs: Schema.number().min(200).max(5000).default(700),
  requestTimeoutMs: Schema.number().min(1000).max(120000).default(60000),
})

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

export function apply(ctx, config) {
  const bridge = new Bridge(config)
  const pollMs = config.autoPlayPollMs || 700

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
        const prompt =
          '<sts2_autoplay>\n' +
          `The game is waiting for you (phase: ${state.phase}, token: ${state.token}).\n` +
          'Continue playing with the sts2_* tools. Current state:\n' +
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
    return () => {
      autoplay.stop()
      bridge.dispose()
    }
  }, 'sts2.bridge')

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === autoplay.agent) autoplay.stop()
  })

  // ---- Read tools ---------------------------------------------------------

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
    'sts2_play_card',
    'Play a card during your combat turn. Use the hand index or the card name from sts2_state. ' +
    'Returns the updated state; if a card opens a selection screen, the new phase shows it.',
    {
      card: { type: 'string', required: true, description: 'Hand index (0-based) or card name.' },
      target: { type: 'string', description: 'Enemy index/name, or "self". Defaults to the first alive enemy for attacks.' },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_use_potion',
    'Use a potion during combat. potion is a slot index or a potion name from sts2_state.',
    {
      potion: { type: 'string', required: true, description: 'Potion index or name.' },
      target: { type: 'string', description: 'Optional target (enemy index/name or "self").' },
    },
    { bridge, timeoutMs: 30000 },
  ))

  ctx.tools.register(textTool(
    'sts2_end_turn',
    'End your combat turn. Then call sts2_wait to block until your next turn.',
    {},
    { bridge, timeoutMs: 15000 },
  ))

  ctx.tools.register(textTool(
    'sts2_choose',
    'Choose an option in the current non-combat screen: map node, reward, card reward, card choice, relic, rest site, event or shop entry. ' +
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
    'close the shop shelf, leave a room, open a treasure chest, or advance the game-over screen.',
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
      return 'Autoplay is on. I will queue the current state whenever the game needs input. Start by reading sts2_state.'
    },
  }))
}
