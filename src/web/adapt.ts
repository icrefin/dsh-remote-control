/**
 * The display layer injected into every tunnelled shell document.
 *
 * The shipped client is built for a desktop viewport. It already collapses its
 * own sidebar to a rail when it is narrow, so a phone is *usable* without any
 * help — but three things are still wrong there, and each is fixed here rather
 * than in the app:
 *
 * 1. **The keyboard covers the composer.** The viewport has no
 *    `interactive-widget` hint, so a soft keyboard overlays the layout instead
 *    of shrinking it. `resizes-content` puts the composer back in view.
 * 2. **The desktop layout is unreachable.** Below the design width the client
 *    reflows, which is usually right; sometimes you want the whole three-column
 *    desktop arrangement at once. Switching the viewport meta to a fixed width
 *    makes the browser fit that layout to the screen, and pinch-zoom still works
 *    for detail.
 * 3. **Double-tap zoom fires on controls.** `touch-action: manipulation` keeps
 *    pinch-zoom but drops the double-tap gesture and its 300 ms delay.
 *
 * The payload is inert on a desktop viewport: the switcher never renders at or
 * above the design width, and nothing else changes the document.
 *
 * It is applied **only to tunnelled responses**, so a browser running on the
 * host itself never sees it (see `relay/PROTOCOL.md` §3.4).
 *
 * @module dsh-remote-control/web/adapt
 */

/**
 * Layout width the desktop arrangement needs.
 *
 * Chosen empirically: below this the client's own rail layout is the better
 * answer anyway, so "Fit" is only offered where it is a real alternative.
 */
export const DESIGN_WIDTH = 1120

/** Marks the payload, so a second splice is a no-op. */
const MARK = 'data-dsh-remote-adapt'

/**
 * Runs before first layout: pick the viewport the stored mode asks for.
 *
 * This has to be in the document head, ahead of the first measurement, or the
 * client lays out once for the wrong viewport and the switch visibly jumps.
 */
const HEAD = `<meta name="${MARK}" content="head" />
<script ${MARK}="head">(() => {
  try {
    var mode = localStorage.getItem('dsh-remote-display') || 'native'
    var design = ${DESIGN_WIDTH}
    // Measured here, before any mode is applied: with the shell's own
    // device-width meta still in force, innerWidth IS the device width. Once
    // Fit is on the layout is ${DESIGN_WIDTH} wide, and comparing against that
    // would call every phone a desktop and strand it in Fit. screen.width is
    // not a substitute — it reports the physical display, which disagrees with
    // the window on a desktop and is absent in some embeds.
    window.__dshRemoteDeviceWidth = Math.round(innerWidth)
    var narrow = window.__dshRemoteDeviceWidth < design
    var meta = document.querySelector('meta[name="viewport"]')
    if (mode === 'fit' && narrow) {
      if (meta) meta.setAttribute('content', 'width=' + design + ', viewport-fit=contain, interactive-widget=resizes-content')
    } else if (meta) {
      meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=contain, interactive-widget=resizes-content')
    }
    document.documentElement.setAttribute('data-dsh-remote-control', mode)
  } catch (error) { /* a private-mode localStorage denial must not break the app */ }
})()</script>`

/** Runs after the client's own boot scripts: styles, then the mode switcher. */
const BODY = `<meta name="${MARK}" content="body" />
<style ${MARK}="style">
html[data-dsh-remote-control]{-webkit-text-size-adjust:100%;text-size-adjust:100%}
html[data-dsh-remote-control] body{touch-action:manipulation;overscroll-behavior-y:none}
html[data-dsh-remote-control] button,html[data-dsh-remote-control] [role="button"],html[data-dsh-remote-control] a{touch-action:manipulation}
html[data-dsh-remote-control] input,html[data-dsh-remote-control] textarea{touch-action:manipulation}
#dsh-remote-display{position:fixed;z-index:2147483000;right:calc(10px + env(safe-area-inset-right));bottom:calc(10px + env(safe-area-inset-bottom));display:none;align-items:center;gap:6px;padding:7px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 82%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary,#111);font:500 12px/1.2 var(--dsw-font-family-text,system-ui,-apple-system,sans-serif);box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer;opacity:.92}
#dsh-remote-display[data-shown="1"]{display:inline-flex}
#dsh-remote-display:active{opacity:1;transform:scale(.97)}
#dsh-remote-display svg{width:13px;height:13px;flex:none}
#dsh-remote-display span{white-space:nowrap}
</style>
<script ${MARK}="body">(() => {
  if (window.__dshRemoteAdapt) return
  window.__dshRemoteAdapt = true
  var DESIGN = ${DESIGN_WIDTH}
  var KEY = 'dsh-remote-display'
  var MODES = { native: 'Native', fit: 'Fit width' }

  /**
   * The device's own CSS width.
   *
   * Deliberately not window.innerWidth while Fit is on: that follows the
   * viewport meta, so it would report the design width and the switcher would
   * conclude it is on a desktop — hiding the only control that can leave Fit.
   * The reading is refreshed whenever the layout is in native mode, which is
   * when innerWidth is trustworthy again.
   * @returns the device width in CSS pixels.
   */
  function deviceWidth() {
    var mode = document.documentElement.getAttribute('data-dsh-remote-control') || 'native'
    if (mode === 'native') window.__dshRemoteDeviceWidth = Math.round(window.innerWidth)
    return window.__dshRemoteDeviceWidth || window.innerWidth
  }

  /** Apply one mode to the live document. */
  function apply(mode) {
    var meta = document.querySelector('meta[name="viewport"]')
    var narrow = deviceWidth() < DESIGN
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'viewport')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', mode === 'fit' && narrow
      ? 'width=' + DESIGN + ', viewport-fit=contain, interactive-widget=resizes-content'
      : 'width=device-width, initial-scale=1, viewport-fit=contain, interactive-widget=resizes-content')
    document.documentElement.setAttribute('data-dsh-remote-control', mode)
    try { localStorage.setItem(KEY, mode) } catch (error) { /* storage denied */ }
    sync()
  }

  /** Show the switcher only where an alternative layout exists. */
  function sync() {
    var button = document.getElementById('dsh-remote-display')
    if (!button) return
    var mode = document.documentElement.getAttribute('data-dsh-remote-control') || 'native'
    button.textContent = MODES[mode] || mode
    button.setAttribute('data-shown', deviceWidth() < DESIGN ? '1' : '0')
    button.title = 'Remote display: ' + (MODES[mode] || mode)
  }

  /** Build the switcher once the app has a body to hang it on. */
  function mount() {
    if (!document.body || document.getElementById('dsh-remote-display')) return
    var button = document.createElement('button')
    button.id = 'dsh-remote-display'
    button.type = 'button'
    button.setAttribute('aria-label', 'Switch remote display mode')
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      var mode = document.documentElement.getAttribute('data-dsh-remote-control') || 'native'
      apply(mode === 'fit' ? 'native' : 'fit')
    })
    document.body.appendChild(button)
    sync()
  }

  mount()
  window.addEventListener('resize', sync, { passive: true })
  window.addEventListener('orientationchange', () => {
    // A rotation cannot be measured while Fit pins the layout to the design
    // width, and a rotated phone almost always wants the reflow anyway — so
    // leave Fit, which also re-measures.
    var mode = document.documentElement.getAttribute('data-dsh-remote-control') || 'native'
    if (mode === 'fit') apply('native')
    else setTimeout(sync, 250)
  }, { passive: true })
  if (window.visualViewport) window.visualViewport.addEventListener('resize', sync, { passive: true })
})()</script>`

/**
 * The fragments to splice into a tunnelled shell document.
 * @returns head and body markup, both idempotent.
 */
export function adaptSnippet(): { head: string; body: string } {
  return { head: HEAD, body: BODY }
}