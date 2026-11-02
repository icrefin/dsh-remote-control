/**
 * The panel stylesheet.
 *
 * The rules are the workspace's (STYLES.md): --dsw-alias-* tokens rather
 * than literals so light and dark both work, the house button and type scales,
 * and the shared page geometry. The tag is created from the bundle's own
 * factory body, so the client module system claims it and removes it when the
 * plugin is disabled.
 *
 * Class names carry the plugin id so two plugins can never collide.
 *
 * @module dsh-remote-control/client/styles
 */

/** Id of the stylesheet tag, so injection stays idempotent. */
export const STYLE_ID = 'dsh-remote-control-style'

/**
 * Stylesheet for the panel, written to the workspace style contract:
 * `--dsw-alias-*` tokens only, the house button and type scales, the shared
 * page geometry, and a `brand-primary` focus ring on `:focus-visible`.
 */
export const PANEL_CSS = `
/* Page geometry: a full-height column with its own scrolling and a centred
   960px measure, the shape every other plugin page here uses. The container
   carries no top padding; the first header owns the 28px clearance — plus the
   Darwin frame inset — so the view never sits against the app's top boundary. */
.dsh-remote-control-page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;gap:24px;padding:0 clamp(24px,4vw,48px) 48px;overflow:auto;color-scheme:light dark;color:var(--dsw-alias-label-primary);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased}
.dsh-remote-control-page > *{width:100%;max-width:960px}
.dsh-remote-control-head{box-sizing:border-box;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px}
[data-platform=darwin] .dsh-remote-control-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dsh-remote-control-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsh-remote-control-description{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;max-width:56ch}
/* The installed version and its author credit beside the title, in dsh-skill-mgr's
   style: one span, so the credit inherits this rule rather than gaining its own. */
.dsh-remote-control-version{font-size:12px;font-weight:500;color:var(--dsw-alias-label-caption);margin-left:6px;white-space:nowrap;font-variant-numeric:tabular-nums}
/* Neutral by default; the -primary class is the filled one. */
.dsh-remote-control-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 13px;border:none;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:inherit;font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s ease;white-space:nowrap}
.dsh-remote-control-button:hover{background:var(--dsw-alias-interactive-bg-active)}
.dsh-remote-control-button:disabled{opacity:.45;cursor:default}
.dsh-remote-control-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-remote-control-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-remote-control-button:focus-visible,.dsh-remote-control-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-remote-control-field{display:flex;flex-direction:column;gap:8px}
.dsh-remote-control-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-remote-control-row{display:flex;gap:8px;align-items:center}
.dsh-remote-control-input{flex:1;min-width:0;box-sizing:border-box;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;font-size:13px}
.dsh-remote-control-input:disabled{opacity:.45;cursor:default}
/* The reveal toggle sits inside the field's right edge, where a password
   eye is expected to be — not in the button row, which holds actions. */
.dsh-remote-control-inputwrap{position:relative;flex:1;min-width:0;display:flex}
.dsh-remote-control-inputwrap .dsh-remote-control-input{padding-right:34px}
.dsh-remote-control-eye{position:absolute;top:50%;right:5px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-remote-control-eye:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-remote-control-eye:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-remote-control-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* Sits under the scan hint: the link's lifetime is a different thing from the
   pairing's, and the panel is where that gets confused. */
.dsh-remote-control-lifetime{margin-top:8px;max-width:64ch}
.dsh-remote-control-field-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-remote-control-pair-hint{margin:0 0 12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-remote-control-warning{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
/* The connection test's result list: one row per step, dim when skipped. */
.dsh-remote-control-checks{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;font-size:13px}
.dsh-remote-control-check{display:flex;align-items:flex-start;gap:8px}
.dsh-remote-control-check-mark{flex:none;width:14px;text-align:center;font-size:12px;line-height:20px}
.dsh-remote-control-check-ok .dsh-remote-control-check-mark{color:var(--dsw-alias-state-success-primary)}
.dsh-remote-control-check-bad .dsh-remote-control-check-mark{color:var(--dsw-alias-state-error-primary)}
.dsh-remote-control-check-body{min-width:0;display:flex;flex-direction:column}
.dsh-remote-control-check-name{color:var(--dsw-alias-label-primary)}
.dsh-remote-control-check-detail{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-remote-control-check[data-skipped=true] .dsh-remote-control-check-name{color:var(--dsw-alias-label-tertiary)}
.dsh-remote-control-check-heading{margin:0;font-size:13px;font-weight:600}
.dsh-remote-control-check-summary{margin:0;font-size:13px;line-height:20px}
.dsh-remote-control-check-summary[data-ok=true]{color:var(--dsw-alias-state-success-primary)}
.dsh-remote-control-check-summary[data-ok=false]{color:var(--dsw-alias-state-error-primary)}
.dsh-remote-control-test{display:flex;flex-direction:column;gap:10px}
.dsh-remote-control-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform);padding:16px;display:grid;grid-template-columns:max-content 1fr;gap:10px 20px;font-size:13px}
.dsh-remote-control-key{color:var(--dsw-alias-label-secondary)}
.dsh-remote-control-value{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);word-break:break-all}
.dsh-remote-control-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dsh-remote-control-pair{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform);padding:16px;display:flex;flex-direction:column;align-items:flex-start}
/* A pairing QR is read by a camera, so it stays black-on-white in both themes —
   theming it is precisely what breaks it. The one deliberate exception here,
   and it is functional rather than decorative. */
.dsh-remote-control-qr{display:block;background:#fff;border-radius:10px;padding:8px;width:320px;height:320px}
.dsh-remote-control-link{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;word-break:break-all;flex:1;user-select:all;color:var(--dsw-alias-label-secondary)}
`

/** Append the stylesheet once per document. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.append(style)
}