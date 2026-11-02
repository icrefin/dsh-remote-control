/**
 * Identifiers and the injection list shared by the browser half and its tests.
 *
 * These live in a plain `.ts` module on purpose: the host `tsconfig` excludes
 * `src/client`, so a test that imports a `.tsx` cannot be typechecked without a
 * JSX setting it does not have. Anything a test needs from the browser half
 * belongs here rather than in the component entry.
 *
 * @module dsh-remote-control/client/plugin
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dshRemoteControl'

/** The id shared by the sidebar row and the main panel it opens. */
export const PANEL_ID = 'dshRemoteControl'

/** Services required by the two registrations. */
export const inject = ['slots', 'locale']