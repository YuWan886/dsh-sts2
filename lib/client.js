/**
 * dsh-sts2 — browser half.
 *
 * dsh discovers this file through `package.json` → `exports["./client"]` +
 * `dsh.client { platform: 'web' }`, concatenates it into the boot combo script
 * and executes it as a classic script. The bundle only REGISTERS a module
 * factory; nothing runs until the loader materializes the module.
 *
 * The card lands in the Plugins page (侧边栏「插件」 → dsh-sts2 → `sts2` 行 →
 * 配置). dsh 0.2.x exposes a plugin's own Config schema as a settings form
 * keyed by its profile entry id, and `plugins.row.config` is keyed by
 * `<package name>#<row id>` — here `dsh-sts2#sts2`. The page hands the card
 * `form.state` (the resolved host/port/token values) and
 * `form.mutate(operations, expectedRevision)`; only `volatile()` fields are
 * editable live, which is exactly the three fields this card owns.
 *
 * Everything is defensive on purpose: a throw at boot could take the whole web
 * shell down with it, and an unknown `inject` would stall boot entirely.
 */
;(function registerSts2Client() {
  'use strict'

  var loader = typeof globalThis === 'undefined' ? undefined : globalThis.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return

  var ENTRY_ID = 'dsh-sts2'
  /** `<package name>#<row id>` — the profile entry dsh-sts2's patch inserts. */
  var ROW_KEY = 'dsh-sts2#sts2'
  /** Slot the card contributes to; the Plugins page owns and declares it. */
  var SLOT = 'plugins.row.config'

  loader.load({
    id: ENTRY_ID,
    factory: function sts2ClientFactory(require) {
      var React = require('react')
      return {
        name: ENTRY_ID,
        // Only `slots` is required. `settingsScope` does not exist in dsh 0.2.x,
        // and a missing service keeps the whole web boot from completing.
        inject: ['slots'],
        apply: function applyClient(ctx) {
          mount(ctx, React)
        },
      }
    },
  })

  /** Register the row's configuration card; tolerate a host without the slot. */
  function mount(ctx, React) {
    if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
    try {
      ctx.slots.inject(SLOT, function registerRow() {
        return ctx.slots.register({ name: SLOT, key: ROW_KEY }, function Sts2RowConfig(props) {
          return renderRow(React, props || {})
        })
      })
    } catch (error) {
      /* A failed registration must never break boot. */
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering (plain React.createElement — no JSX, no build step)
  // ---------------------------------------------------------------------------

  var COLORS = {
    ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
    bad: 'var(--dsw-alias-state-error-primary, #e03131)',
    idle: 'var(--dsw-alias-label-tertiary, #868e96)',
    label: 'var(--dsw-alias-label-primary, inherit)',
    hint: 'var(--dsw-alias-label-secondary, #868e96)',
    border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
    bg: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
  }

  /**
   * The row's card: a text summary for the collapsed view (used when the
   * package has no description) and the editable page otherwise. The view
   * switch lives outside the hook component so hook order stays stable.
   */
  function renderRow(React, props) {
    if (props.view === 'summary') {
      return '杀戮尖塔 2 桥接端点与 token / Slay the Spire 2 bridge endpoint'
    }
    var merged = {}
    for (var key in props) if (Object.prototype.hasOwnProperty.call(props, key)) merged[key] = props[key]
    merged.React = React
    return React.createElement(Sts2BridgeForm, merged)
  }

  /** The editable page. */
  function Sts2BridgeForm(props) {
    var React = props.React
    var form = props.form
    var state = form && form.state ? form.state : undefined
    var value = (state && state.value) || {}
    var status = state ? state.status : 'unavailable'
    var writable = state ? state.writable !== false : false

    var hostState = React.useState(textOf(value.host, '127.0.0.1'))
    var hostText = hostState[0]
    var setHostText = hostState[1]
    var portState = React.useState(textOf(value.port, '26333'))
    var portText = portState[0]
    var setPortText = portState[1]
    var tokenState = React.useState('')
    var tokenText = tokenState[0]
    var setTokenText = tokenState[1]
    var noteState = React.useState('')
    var note = noteState[0]
    var setNote = noteState[1]

    // Re-seed the drafts when the accepted values change underneath us.
    React.useEffect(
      function () {
        setHostText(textOf(value.host, '127.0.0.1'))
        setPortText(textOf(value.port, '26333'))
      },
      [value.host, value.port],
    )

    var endpoint = textOf(value.host, '127.0.0.1') + ':' + textOf(value.port, '26333')
    var ready = status === 'ready' && writable

    var submit = function (operations) {
      if (!form || typeof form.mutate !== 'function') return
      if (operations.length === 0) {
        setNote('没有改动 / nothing to save')
        return
      }
      setNote('保存中… / saving…')
      Promise.resolve(form.mutate(operations, state && state.revision))
        .then(function (accepted) {
          setNote(accepted === false ? '保存被拒绝，请重试 / save rejected' : '已保存，桥接会按新设置重连 / saved')
        })
        .catch(function (error) {
          setNote('保存失败 / save failed: ' + (error && error.message ? error.message : String(error)))
        })
    }

    var save = function () {
      var port = Number(portText)
      if (portText !== '' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        setNote('端口必须是 1-65535 的整数 / port must be 1-65535')
        return
      }
      var operations = []
      var host = String(hostText || '').trim()
      if (host !== '') operations.push({ op: 'set', path: ['host'], value: host })
      if (portText !== '') operations.push({ op: 'set', path: ['port'], value: port })
      if (tokenText !== '') operations.push({ op: 'set', path: ['token'], value: tokenText })
      submit(operations)
    }

    var clearToken = function () {
      setTokenText('')
      submit([{ op: 'set', path: ['token'], value: '' }])
    }

    return React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' } },
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement(
          'div',
          { style: { fontSize: '13px', fontWeight: 600, color: COLORS.label } },
          '杀戮尖塔 2 桥接 / Slay the Spire 2 bridge',
        ),
        React.createElement(
          'div',
          { style: { color: COLORS.hint, lineHeight: 1.6 } },
          'dsh 通过本机 TCP 连接游戏内「AI 队友」mod 的外部 Agent 桥接。端口必须与游戏内设置一致（默认 26333）。',
        ),
      ),
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            borderRadius: '8px',
            border: '1px solid ' + COLORS.border,
            background: COLORS.bg,
          },
        },
        React.createElement('span', {
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: ready ? COLORS.ok : COLORS.idle,
            flex: 'none',
            display: 'inline-block',
          },
        }),
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          React.createElement(
            'span',
            { style: { color: COLORS.label, fontWeight: 600 } },
            '当前端点 / endpoint',
          ),
          React.createElement('span', { style: { color: COLORS.hint } }, endpoint),
          React.createElement(
            'span',
            { style: { color: COLORS.hint } },
            '连接状态显示在游戏内 设置 → 模组设置 → AI 队友 → 外部 Agent（dsh）',
          ),
        ),
      ),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '90px minmax(0,1fr)', gap: '8px 10px', alignItems: 'center' } },
        React.createElement('span', { style: { color: COLORS.hint } }, '地址 / host'),
        React.createElement('input', {
          type: 'text',
          value: hostText,
          spellCheck: false,
          onChange: function (event) {
            setHostText(event.target.value)
          },
          style: fieldStyle(),
        }),
        React.createElement('span', { style: { color: COLORS.hint } }, '端口 / port'),
        React.createElement('input', {
          type: 'number',
          min: 1,
          max: 65535,
          value: portText,
          onChange: function (event) {
            setPortText(event.target.value)
          },
          style: fieldStyle(),
        }),
        React.createElement('span', { style: { color: COLORS.hint } }, 'token'),
        React.createElement('input', {
          type: 'password',
          value: tokenText,
          placeholder: '留空则保持原值 / leave blank to keep',
          onChange: function (event) {
            setTokenText(event.target.value)
          },
          style: fieldStyle(),
        }),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: save,
            disabled: !ready,
            style: {
              font: 'inherit',
              fontSize: '12px',
              padding: '3px 12px',
              cursor: ready ? 'pointer' : 'not-allowed',
              opacity: ready ? 1 : 0.5,
              color: 'var(--dsw-alias-label-primary-foreground, #fff)',
              background: 'var(--dsw-alias-button-primary-fill, #1971c2)',
              border: '0',
              borderRadius: '6px',
            },
          },
          '保存 / save',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: clearToken,
            disabled: !ready,
            style: {
              font: 'inherit',
              fontSize: '12px',
              padding: '3px 12px',
              cursor: ready ? 'pointer' : 'not-allowed',
              opacity: ready ? 1 : 0.5,
              color: COLORS.hint,
              background: 'transparent',
              border: '1px solid ' + COLORS.border,
              borderRadius: '6px',
            },
          },
          '清空 token',
        ),
        note ? React.createElement('span', { style: { color: COLORS.hint } }, note) : null,
      ),
      ready
        ? null
        : React.createElement(
            'div',
            { style: { color: COLORS.bad } },
            '设置未就绪：Host 尚未提供 sts2 的设置表单 / settings form not served yet',
          ),
    )
  }

  function fieldStyle() {
    return {
      boxSizing: 'border-box',
      width: '100%',
      padding: '4px 8px',
      fontSize: '12px',
      fontFamily: 'inherit',
      color: COLORS.label,
      background: 'transparent',
      border: '1px solid ' + COLORS.border,
      borderRadius: '6px',
      outline: 'none',
    }
  }

  function textOf(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback
    return String(value)
  }
})()
