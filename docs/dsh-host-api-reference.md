# DSH host-plugin API reference (for a hand-built remote surface)

> **Superseded, kept for reference.** This document was written for the version of
> `dsh-remote-control` that re-implemented a slice of the GUI for the phone: a method table over
> `sessions`, `agents`, `sessionQuery`, `approval` and `workspaceRegistry`, driven by a
> hand-written mobile SPA. That approach was retired — see the plugin README — because the
> browser now runs the shipped client through a tunnel and needs none of this.
>
> Nothing here is wrong, and the facts are still verified against the shipped build. It is
> the *premise* that no longer holds: if you are tempted to build a second remote UI, the
> first plea in the README is to tunnel the real one instead. Read this only if you have a
> concrete reason not to.

Scope: which `ctx.*` services/methods a Cordis **host** plugin must call to list sessions,
read a transcript, send a turn, answer approvals, create sessions, and enumerate workspaces.

Verified against the shipped build **`0.2.1-rc.3`**, and re-diffed for **`0.2.1-rc.5`**:
every `lib/types` declaration of the packages this document cites (`dsh-session`,
`dsh-agent`, `dsh-llm`, `dsh-user-approval`, `dsh-session-query`, `dsh-workspace`,
`dsh-host-webserver`, `dsh-typert-protocol`, `dsh-api-remotes`) is byte-identical
between the two releases, so nothing cited here changed for the rc.5 upgrade.

> **What that verification actually covers.** The per-API claims below were verified
> against `0.2.0-rc.2`, and were **not** re-checked line by line against `0.2.1-rc.3`.
> What was done for `0.2.1-rc.3` is a type-surface diff against the `0.2.0-rc.2`
> baseline: nothing this document cites was removed or renamed. The changes that touch
> its subject matter are `dsh-host-webserver` (`WebServer.port` is now
> `number | undefined`, plus new `getOrigin()`, `protocol`, `TlsConfig`, and the address
> helpers), `dsh-typert-protocol` (new `TypertRemoteInfo` / `createTypertRemoteInfo` and
> the resource-access types), and additive or doc-comment-only edits elsewhere (the
> several packages that also dropped their uncited `./invariant` companion subpath are
> not cited here). `dsh-session-query` and `dsh-agent-loop` were not part of that diff
> set, so the `ctx.sessionQuery` rows and the `dsh-agent-loop` citations below remain
> `0.2.0-rc.2`-verified only.

## Provenance / how to re-verify

- `.js` evidence was read from the Electron asar with
  `python3 /tmp/dshasar.py read <path>` (paths below are asar-absolute, e.g.
  `/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`). Extracted copy: `/tmp/dsx/`.
- `.d.ts` evidence: **the asar ships only `.js` and `.d.ts.map` — no `.d.ts`.** The
  `.d.ts` cited here come from the npm tarballs of `@deepseek-ai/*@0.2.1-rc.3`
  (extracted to `/tmp/dshup/api/newx/<pkg>/`), the same version the asar contains.
  The `0.2.0-rc.2` baseline — the source of the diff and of the line numbers quoted
  below — is at `/tmp/typesprobe/` and `/tmp/dshup/api/oldx/<pkg>/`. Cite them as
  `@deepseek-ai/<pkg>/lib/types/<file>.d.ts`.
- Types are surfaced to TS via `declare module '@deepseek-ai/cordis'` merging `Context`
  and `Events` — you get `ctx.sessions` typed only if you install and (type-)import the
  owning package.

---

## 0. Four corrections to the current code first

These are real bugs in `src/host/dshDataSource.ts` today:

1. **`session.header.title` does not exist.** `SessionHeader` has no `title` field —
   confirmed in the TS interface and in the runtime validator
   (`dsh-session/lib/index.js:1041-1052` lists every accepted key and never mentions
   `title`). Your `session.header?.title?.trim() || session.id` therefore *always* falls
   back to the raw session id. Titles live in a separate log-backed projection (§2d).
2. **`session.header.updatedAt` does not exist.** Same evidence. `updatedAt` is *derived*:
   the shipped API computes `Math.max(header.createdAt, metadata.lastPromptAt ?? 0)`
   (`dsh-api-session-controller/lib/index.js:2040-2042`). Your sort-by-`createdAt` is
   therefore not activity ordering.
3. **`ctx.sessions.list()` returns only *live, in-memory* sessions**, in creation order
   (`dsh-session/lib/index.js:1868-1872`: `[...this.store.values()].map(e => e.session)`).
   Persisted/unloaded sessions are invisible to it. The shipped UI lists the full corpus
   through `ctx.sessionQuery.listSessions()` (§1).
4. **`ctx.sessions` has no delete/remove/dispose.** The full method set is
   `registerMessageProjection, create, prepare, enter, announce, liveEntryFor, get, list, fork`
   plus `flush` (`dsh-session/lib/index.js:` class body). Deletion happens at
   persistence level or via workspace **archive** (§5).

Also: the workspace service is **`ctx.workspaceRegistry`**, not `ctx.workspace`. There is no
`ctx.workspace` service (`ctx.workspaces` is a *client*-side key).

---

## 1. Capability table

Service keys below are the exact strings passed to `super(ctx, "<key>")` in each package
(enumerated mechanically across the whole shipped tree).

| Capability | Exact call | Evidence |
|---|---|---|
| Live sessions only (in-memory) | `ctx.sessions.list(): Session[]` | `dsh-session/lib/index.js:1868` — `/** All live sessions, in creation order. */` |
| One live session | `ctx.sessions.get(id: SessionId): Session \| undefined` | `dsh-session/lib/types/index.d.ts:447` |
| **All sessions, live + persisted** | `await ctx.sessionQuery.listSessions(signal?): Promise<SessionRecord[]>` | `dsh-session-query/lib/types/index.d.ts:67`; record = `{header, live, persisted}` `types.d.ts:14-21` |
| Filter sessions (cwd, createdAt, id, parent, availability) | `await ctx.sessionQuery.filterSessions(filters, signal?): Promise<SessionRecord[]>` | `dsh-session-query/lib/types/index.d.ts:81`; filter union `types.d.ts:170-184` |
| **Full raw event log** | `await ctx.sessionQuery.readSession(id): Promise<SessionLogSnapshot>` | `dsh-session-query/lib/types/index.d.ts:74`; `{session, inheritedEventCount, events}` `types.d.ts:32-41` |
| **Current model surface** | `await ctx.sessionQuery.readSurface(id): Promise<SessionSurfaceSnapshot>` | `dsh-session-query/lib/types/index.d.ts:127`; `{session, inheritedEventCount, capturedThroughSeq, events}` `types.d.ts:22-31` |
| Lightweight event records | `await ctx.sessionQuery.listEvents(id): Promise<SessionEventRecord[]>` | `dsh-session-query/lib/types/index.d.ts:111` |
| One consistent observation (live cursor + projections) | `await ctx.sessionQuery.observeSession(id, {signal?, projectionMode})` | `dsh-session-query/lib/types/observation.d.ts:7-38` |
| Titles (live session) | `ctx.sessionTitle.get(session): SessionTitleSnapshot \| undefined` | `dsh-session-title/lib/index.js:281` |
| Titles (any session, live or cold) | `await ctx.sessionQuery.readTitleSnapshot(id)` / `readTitleSnapshots(ids)` | `dsh-session-query/lib/index.d.ts:105` |
| Rename | `ctx.sessionTitle.rename(session, title): SessionTitleSnapshot` | `dsh-session-title/lib/index.js:295`; throws if session not live |
| Live status (`running`/`idle`) | `ctx.agents.get(sessionId)?.status === 'running'` | `dsh-api-session-controller/lib/index.js:1877`; `AgentStatus = 'idle' \| 'running'` `dsh-agent/lib/types/runtime-types.d.ts:90` |
| Agent for a session | `ctx.agents.get(id): Agent \| undefined` | `dsh-agent/lib/types/index.d.ts:343` |
| Send a turn | `agent.followup(message: UserMessage): void` | `dsh-agent/lib/types/runtime-types.d.ts:192` |
| Steer a running turn | `agent.steer(message: UserMessage): void` | `runtime-types.d.ts:200` |
| Inject context (no wake) | `agent.inject(message: UserMessage): void` | `runtime-types.d.ts:209` |
| Interrupt | `agent.cancel(cause: AgentCancelCause, options?: {keepInbox?: boolean}): void` | `runtime-types.d.ts:157`, `types.d.ts:32-39` |
| Turn settled | `await agent.whenIdle(): Promise<void>` | `runtime-types.d.ts:164` |
| Create session+agent | `await ctx.agents.create({sessionId, meta?, agentOptions, ...}): Promise<AgentHandle>` | `dsh-agent/lib/types/index.d.ts:278`; options `:48-78` |
| Resume persisted session | `await ctx.agents.resume(options): Promise<AgentHandle>` | `dsh-agent/lib/types/index.d.ts:286` |
| Tear down agent+session | `await handle.dispose(): Promise<void>` | `index.d.ts:143-146` ("removes its session from the store") |
| Bare session (no agent) | `ctx.sessions.create(id?, options?)` | `dsh-session/lib/index.js:1653` |
| Approvals policy | `ctx.approval.setPolicy(agent, policy)` | `dsh-user-approval/lib/types/index.js:98` |
| Answer an approval | `ctx.on('approval/request', (req, next) => Outcome)` | `dsh-user-approval/lib/types/types.d.ts` event decl |
| Workspaces | `ctx.workspaceRegistry.list(): Workspace[]` | `dsh-workspace/lib/index.js:452` |
| Create workspace | `await ctx.workspaceRegistry.create(path, title)` | `dsh-workspace/lib/index.js:406` |
| Archive session | `await ctx.workspaceRegistry.archiveSession(sessionId, {stopActivity?})` | `dsh-workspace/lib/index.js:524` |
| Answer ask-user questions | `ctx.userQuestions.ask(request)` | `dsh-user-questions/lib/index.js:668` |

### Ordering and paging facts

- `listSessions` is **newest-first by `createdAt`**, tie-broken by id:
  `return b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id)`
  (`dsh-session-query/lib/index.js:307-309`). It is **not** activity ordering.
  The shipped controller re-computes `updatedAt` and re-sorts
  (`dsh-api-session-controller/lib/index.js:1904`).
- **There is no server-side paging on `listSessions`.** The shipped UI pages
  *history*, not the session list. `readEvent` accepts `before`/`after` bounded windows
  (`readWindowMax` default 50, `dsh-session-query/README.md`).
- For a phone, mirror the shipped controller: call `listSessions()`, prefer the live
  `ctx.sessions.get(header.id)` when present, drop records with `header.cwd === undefined`,
  then sort by your computed `updatedAt`
  (`dsh-api-session-controller/lib/index.js:1888-1904`).

---

## 2. Transcript reading

### 2a. The event envelope and message shapes

`SessionEvent` is a discriminated union on `type` with
`{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`
(`dsh-session/lib/types/types.d.ts:489-500`), `time` = Unix epoch ms.

**`data` is not uniform across message events.** The runtime validator proves the split:

```js
const message = type === "user/message" ? record : record?.["message"];
```
`dsh-session/lib/index.js:1196` — i.e.

| event type | message location | role |
|---|---|---|
| `user/message` | `event.data` **is** the message | `user` |
| `developer/message` | `event.data.message` | `developer` |
| `system/message` | `event.data.message` | `system` |
| `assistant/message` | `event.data.message` | `assistant` |
| `tool/result` | `event.data.message` | `tool` |

Surface-eligible types (same set) — `dsh-session/lib/index.js:154-160`.

Message value shape (`dsh-llm/lib/types/message.js`):

```js
createMessage({ ...input, id: brandString(randomUUID()) })   // { id, role, content, source }
createUserMessage({ content, source })         // role: 'user'
createToolResultMessage({ callId, content, isError })
  // { role:'tool', source:{kind:'tool',callId}, toolCallId: callId, content, isError }
```

Content blocks (`dsh-llm/lib/types/assembler.js:97-104`):

```js
{ type: 'text',      text }
{ type: 'reasoning', text }
{ type: 'tool-call', id, name, arguments }   // arguments is a string
```

**Tool calls vs. tool results.** A *call* is a `tool-call` content block inside an
`assistant/message`. A *result* is a **separate** `tool/result` event whose message carries
`toolCallId` and (only when `isError === true`) an optional error identity:

```js
'tool/result': { turn, step, message: ToolResultMessage,
                 error?: { name, code, reason? }, meta?: JsonValue }
```
`dsh-session/lib/types/types.d.ts:374-385`. Pair them on
`assistantMsg.content[].id === toolResultMsg.toolCallId`.

Timestamps: per-event `event.time`; per-message `assistant/message` also carries
`{turn, step, message, stream, usage?, interrupted?}` (`types.d.ts:330-338`).

### 2b. Reading the transcript — use append-origin events, not `readSurface`

**Important, non-obvious:** `readSurface()` returns the *model* surface, which hides
replaced ranges. The package documents that this is the wrong source for a human
transcript:

> "The model-visible surface deliberately shadows replaced ranges, so it is the wrong
> source for a human transcript — a landed replacement would erase conversation the user
> already saw. Append-origin events are that transcript's durable source material."
> — `dsh-session/lib/index.js:183-186` (JSDoc of `isAppendSurfaceEvent`)

The shipped transcript pager uses exactly that predicate — `MESSAGE_TYPES` at
`dsh-api-session-controller/lib/types/history.js:60`, the check at `:409`, inside
`paginate` at `:395`:

```js
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);
...
if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue;
```

`isAppendSurfaceEvent` and `isSurfaceEvent` are exported from `@deepseek-ai/dsh-session`
(`dsh-session/lib/index.d.ts:31`).

**Recommended phone transcript recipe** (best fidelity, cold-safe, matches the shipped UI):

```ts
const obs = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
// obs.header, obs.events (raw log snapshot at obs.cursor), obs.projections, obs.cursor
for (const event of obs.events) {
  if (!isAppendSurfaceEvent(event)) continue      // human transcript source
  const msg = event.type === 'user/message' ? event.data : event.data.message
  // render msg.role / msg.content / event.time / event.seq
}
obs[Symbol.dispose]()
```

`observeSession` gives the header, the raw-event cut, the last seq, and projection values
in one consistent observation (`dsh-session-query/lib/types/observation.d.ts:7-38`).

For a bounded, message-aligned page the shipped UI walks backwards from a cursor and cuts
at `maxMessages` (default 50) or a "turn window" (`history.js:395-420`).
`beforeSeq`/`maxMessages`/`turnWindow` are validated at `history.js:337-360`.

**Live-session shortcut.** If the session is live in memory you can skip `sessionQuery` and
project straight off the `Session` object (`dsh-session/lib/types/index.d.ts`):

```ts
session.snapshotEvents(): readonly SessionEvent[]   // deep-frozen log snapshot
session.deriveEventMessage(event): Message | null   // :310 — one event's projected message
session.deriveMessages(): Message[]                 // :303 — whole model history
session.seq: number                                 // log length, no array materialization
```
`deriveMessages()` is the *model* history (projections applied, replacements folded), so it
has the same "wrong source for a human transcript" caveat as `readSurface()`. Use
`snapshotEvents()` + `isAppendSurfaceEvent` for the human view.

### 2c. Streaming / partial assistant text

`readSurface` / `readSession` return **committed** messages only — there is no
partial-assistant read API on the query service. Live partial text comes as an **event**:

```js
ctx.on('agent/assistant-stream', ({ agent, frame }) => { ... }, { global: true })
```
Real usage: `dsh-api-session-controller/lib/types/history.js:181-190`.

Frame union (emitted by `dsh-agent-loop/lib/index.js:386-442`, declared
`dsh-agent/lib/types/runtime-types.d.ts:106-140`):

```ts
| { type:'start', attemptId, revision, turn, step }
| { type:'chunk', attemptId, revision, index, time, chunk }   // chunk is a model delta
| { type:'end',   attemptId, revision, index,
    outcome: { kind:'committed', eventType, seq } | { kind:'abandoned' } }
```
`index` is dense from 0; `end.index` is the next position. `chunk` is one of
`text-delta` / `reasoning-delta` / `tool-call-delta` (`dsh-llm/lib/types/assistant-stream.js:44-70`).
The stream is **presentation data only** — the durable `assistant/message` is the replay
source (`dsh-agent/README.md:67`). The shipped UI accumulates frames and drops those
superseded by the committed snapshot baseline
(`history.js:188-190`, `wireAssistantStreamFrame` at `history.js:301-308`).

---

### 2d. Titles (since `header.title` does not exist)

Titles are folded from a `session/title` **log event**, not stored on the header. Two paths:

```ts
// (a) live session in memory — full snapshot
const snap = ctx.sessionTitle.get(session)
// snap: { title, messageSeqs, source: {kind:'fallback'|'provider'|'user', ...},
//         eventSeq, updatedAt }        — undefined before any title exists
```
`dsh-session-title/lib/index.js:281` (`foldSessionTitle` at `:188` builds the snapshot,
`titleSnapshotFromState` at `:122`).

```ts
// (b) any session, live or persisted — survives unloaded sessions
const obs = await ctx.sessionQuery.readTitleSnapshot(sessionId)   // { session, title? }
const [r1, r2] = await ctx.sessionQuery.readTitleSnapshots([id1, id2])
```
`dsh-session-query/lib/types/index.d.ts:105`; results are per-session settled results, so one
missing session does not reject the batch.

**For a live session the shipped UI does not call either one** — it reads the registered
projection, which is what the client wire carries. The title projection key is exactly
`"title"` and its view is `string | null`:

```js
const titleProjectionDefinition = {
  key: 'title', stateVersion: 1, stateSchema: titleViewSchema, // z.string().min(1).nullable()
  init: () => null,
  apply: (state, event) => event.type === 'session/title' ? event.data.title : state,
  wire: { viewSchema: titleViewSchema, view: (state) => state },
}
```
`dsh-session-title/lib/index.js:170-183` (`titleViewSchema` at `:170`, the definition at
`:172`, `key` at `:173`). Read it with:

```ts
const snap = ctx.sessionProjections.snapshot(session)   // :142 — { asOfSeq, values }
const title = snap.values.title as string | null       // '' / null when untitled
ctx.sessionProjections.stateOf(session, 'title')        // :127 — raw host state, no wire view
```
Both take a **live `Session` object**, not an id. Rename with
`ctx.sessionTitle.rename(session, title)` (`:295`), which appends a user-sourced
`session/title` event and throws `SessionTitleInvalidError` when the title normalizes to
empty. `refresh(session, signal)` re-runs generation (`:319`).

**Practical phone recipe:** for live sessions use
`ctx.sessionProjections.snapshot(session).values.title`; for the cold tail of the list call
`ctx.sessionQuery.readTitleSnapshots(ids)`; fall back to the session id.

---

## 3. Sending a turn, completion, interruption

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const agent = ctx.agents.get(sessionId)          // bare Agent, live only
if (agent === undefined) {
  // not live: resume it first (needs ctx.sessionPersistence mounted)
  const handle = await ctx.agents.resume({ sessionId, agentOptions: { provider, model } })
}
agent.followup(createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
}))
```

This is exactly the shipped controller's path
(`dsh-api-session-controller/lib/index.js:872-883`):

```js
const message = createUserMessage({ content: ..., source })
if (this.ctx.agents.get(agent.id) !== agent) throw new RemoteError('session/not-found', ...)
if (request.mode === 'steer') agent.steer(message)
else agent.followup(message)
```

Note `agent.followup()` is **synchronous and returns `void`** — it queues and wakes the
driver; there is no promise for the turn. `source.kind` is a closed-ish union; `'user'` is
used for human prompts, `'user-approval'` for policy notices
(`dsh-user-approval/lib/types/index.js:104`), `{kind:'plugin', plugin}` for plugin input
(`dsh-agent/README.md:56`).

### Knowing when the turn finishes or errors

Two independent mechanisms — use both:

1. **Durable log events** (arrive on `session/event`):

| Event | Payload | Meaning |
|---|---|---|
| `turn/start` | `{ turn }` | turn opened |
| `turn/end` | `{ turn, reason: TurnEndReason }` | turn closed |
| `step/start` | `{ turn, step }` | model call + its tools |
| `step/end` | `{ turn, step }` | step closed |
| `assistant/attempt` | — | attempt that committed no message |

`dsh-session/lib/types/types.d.ts:255-286`, `:344`.

`TurnEndReason` union (`types.d.ts:165-210`): `{kind:'completed'}`, `{kind:'aborted', reason}`,
`{kind:'blocked'}`, `{kind:'error', error: LlmFailure}`, `{kind:'max-tokens'}`,
`{kind:'interrupted'}`, `{kind:'forked'}`. The last two are *never* live-emitted by the loop
(crash recovery / fork seeds).

2. **Live events**: `agent/status` (`{agent, status}`), `agent/error`
   (`{agent, turn, step, error}`, emitted at `dsh-agent-loop/lib/index.js:880`), and
   `agent/request-error` (waterfall, retryable).

Quiescence: `await agent.whenIdle()`. **Caveat from the source:** it "does not identify the
settlement of any particular message" (`runtime-types.d.ts:158-164`), and the README notes
consumers that read storage after `whenIdle()` must flush themselves (`types.d.ts:266-272`).

### Interrupting

```ts
agent.cancel({ kind: 'user' })                    // discard queued input
agent.cancel({ kind: 'user' }, { keepInbox: true })  // abort the turn, keep the queue
```
`cancel` is `void` (synchronous abort). The shipped stop button uses
`agent.cancel({ kind: 'user' })` with `keepInbox` (`dsh-agent/README.md:110`). Causes are
the `AgentCancelCause` union exported from `@deepseek-ai/dsh-session`; one variant seen in
source is `{ kind: 'disposed' }` (`dsh-agent-loop/lib/index.js:885`). **I did not enumerate
the full `AgentCancelCause` union** — see §7.

---

## 4. Approvals (phone-critical)

**Service key: `ctx.approval`.** `super(ctx, 'approval')` —
`dsh-user-approval/lib/types/index.js:76`.

### Asking (you normally don't — tools do this for you)

```ts
async request(req): Promise<ApprovalOutcome>
```
`dsh-user-approval/lib/types/index.js:130`. Appends `approval/asked` then
`approval/decided` around the decision. **Throws outside an open turn** — the audit pair
must be turn-enclosed.

### Answering — register a waterfall listener

```ts
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

ctx.on('approval/request', (req, next) => {
  // req: ApprovalRequestEvent
  // return an outcome to CLAIM the request, or `next()` to delegate
  return myPendingApprovals.waitFor(req)     // Promise<'allowed-once' | 'rejected' | ...>
})
```

Typed declaration (`dsh-user-approval/lib/types/types.d.ts:81`; the request interface is at
`:55`, the outcome union at `:26`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'approval/request'(this: Scoped<Agent>,
                       req: ApprovalRequestEvent,
                       next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
  }
}
```
`@mode waterfall`; agent-scoped listeners receive only that agent's requests.

`ApprovalRequestEvent` — note the **`Event` suffix**:

```ts
export interface ApprovalRequestEvent {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: ToolCallId;
  readonly reason?: string;
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
  readonly signal?: AbortSignal;
}
```

**Outcome union — the only grant is one-shot:**

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
```

There is **no `allow-always` / remembered grant** and no grant store; the README states it
under Known Limitations ("Only one-shot grants exist"), and the closed union above is the
proof. A "remember" affordance in the phone UI must be implemented by *you* (e.g. auto-answer
future matching requests) — the host has no such scope. Session policy is only
`'ask' | 'never'` (`APPROVAL_POLICIES`, `dsh-user-approval/lib/types/index.js:29`).

**Delegate with `next()`.** Returning `next()` hands the request to the next answerer; the
terminal default resolves `'unavailable'`, which fails the tool call **closed**
(`.../index.js:176`):
`this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, () => Promise.resolve('unavailable'))`.

A minimal host-side answerer template, adapted from the shipped ACP bridge
(`dsh-acp/lib/index.js:1116-1139`), which is the closest thing to "a non-browser client
answers approvals":

```js
ctx.on('approval/request', (request, next) => {
  if (request.callId === undefined) return next()          // delegate what you can't correlate
  return myTransport.askPhone({
    sessionId: request.agent.session.id,
    toolName: request.toolName,
    callId: request.callId,
    reason: request.reason,
    displayReason: request.displayReason,
    signal: request.signal,                                 // abort ⇒ dismiss the phone dialog
  }).then((answer) => answer === 'allow' ? 'allowed-once' : 'rejected')
})
```

`@mode waterfall` + `{ global: true }`: the shipped controller registers its global
listeners with `{ global: true }` (`history.js:162-190`). Whether an approval listener needs
`global: true` depends on your plugin's fiber scope — the agent-scoped dispatch means a
listener registered on a *non*-agent context may not see agent-scoped requests. The shipped
consumers use `{ global: true }` for related session/agent events; **I did not find a
shipped host answerer that omits it**, so register with `{ global: true }` unless you can
verify scoping.

### Policy

```ts
ctx.approval.setPolicy(agent, 'never' | 'ask'): void       // live switch + notifies the model
ctx.approval.effectivePolicy(session): 'ask' | 'never'     // read current
setApprovalPolicy(session, policy): void                   // exported fn, durable write path
```
`dsh-user-approval/lib/types/index.js:98`, `:150`, `:63`. Under `'never'` the service
returns `'rejected'` **before** any listener runs (`.../index.js:175`), so a listener cannot
override it.

### Where the human prompt reaches the shipped UI

`dsh-api-remotes` forwards `approval/request` to the browser as a **waterfall remote event**:

```js
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  ...
  { event: 'user-questions/request', mode: 'waterfall' },
]
```
`dsh-api-remotes/lib/types/remote-events.js:12` (the `approval/request` entry);
the runtime list is at `dsh-api-remotes/lib/index.js:17-23`. The browser subscribes with
`ctx.remote.$on('approval/request', function (request, next) { ... })` and answers
`'allowed-once'` on Enter / `'rejected'` on Escape
(`dsh-client-ui-approval/lib/client.js:355`, `:79`). **This is the pattern to copy for the
phone**: expose the same waterfall over your own transport.

### ask_user questions (adjacent, same shape)

`ctx.userQuestions.ask(request)` → `ctx.waterfall('user-questions/request', request, noAnswerer)`
(`dsh-user-questions/lib/index.js:668-684`), also forwarded to the client as a waterfall.
If the phone should answer `ask_user_question` prompts too, register a listener on
`user-questions/request` with the same `(request, next)` shape. **I did not enumerate the
`UserQuestionRequest` field shape** — see §7.

---

## 5. Creating and deleting sessions

### Create (with an agent — what you want)

```ts
const handle = await ctx.agents.create({
  sessionId,                       // SessionId (required)
  meta: { cwd: '/abs/path' },      // optional: absolute cwd
  agentOptions: { provider, model, reasoningEffort?, maxTokens? },
  // parentAgent?, seed?, inheritedEventCount?, setup?
}): Promise<AgentHandle>
```
`dsh-agent/lib/types/index.d.ts:278`; options at `:48-78`. `meta.cwd` must be an
**absolute** path or the session boundary rejects it
(`dsh-session/lib/index.js:1044-1047`). `ctx.agents.resume({sessionId, ...})` loads a
persisted session instead and requires `ctx.sessionPersistence`
(`dsh-agent/lib/types/index.d.ts:286`).

### Create (bare session, no agent)

```ts
ctx.sessions.create(id?, { meta: { cwd?, parentSession?, createdAt?, isSeeded?,
                                   origin?: 'subagent', delegationDepth?, agentPreset? },
                           seed?, inheritedEventCount? }): Session
```
`dsh-session/lib/index.js:1653`; `CreateSessionOptions` at
`dsh-session/lib/types/types.d.ts:101-123`. Omit `id` and the store mints `session-<n>`.

### Delete — there is no session delete on `ctx.sessions`

- **`ctx.workspaceRegistry.delete(id)` deletes a *workspace registration*, not sessions**,
  and explicitly "retain[s] its directory and every session log"
  (`dsh-workspace/lib/index.js:462-467`).
- **`ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`** hides a
  session from grouping while keeping history; `unarchiveSession`, `pinSession`,
  `unpinSession` are the counterparts (`dsh-workspace/lib/index.js:524-620`). Agents are
  reported as the `turn` activity family, so archiving a running session refuses unless you
  pass `stopActivity` (`dsh-agent/README.md:110`).
- True log deletion lives in the **persistence** layer. **I did not confirm a public
  persistence delete method name** — see §7. The shipped ACP bridge removes sessions by
  disposing the agent (`sessions.delete(sessionId)` is a local `Map`, not the service).

**Recommendation for the phone:** map "delete" onto `archiveSession` (reversible, matches
the product) or `handle.dispose()`, and do not promise log erasure you haven't verified.

---

## 6. Workspaces

**Service key: `ctx.workspaceRegistry`** (`super(ctx, 'workspaceRegistry')`,
`dsh-workspace/lib/index.js:374`). It is mounted by the desktop/web-app bundle, not by
`dsh-base` (`dsh-web-app/cordis.patch.yml:92`), so guard for its absence if you also run
headless.

```ts
ctx.workspaceRegistry.list(): Workspace[]              // durable registry order, no I/O
ctx.workspaceRegistry.get(id): Workspace | undefined
await ctx.workspaceRegistry.create(path, title?): Promise<Workspace>
await ctx.workspaceRegistry.initializeDefault(resolveDirectory)
ctx.workspaceRegistry.delete(id): Promise<boolean>     // registration only
await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity? })
await ctx.workspaceRegistry.unarchiveSession(sessionId)
await ctx.workspaceRegistry.pinSession(sessionId) / unpinSession(sessionId)
```
`dsh-workspace/lib/index.js:443-620`.

`Workspace` entity (`dsh-workspace/lib/index.js:88-176`):

```ts
id, path, title, createdAt, updatedAt, sessionIds: string[]   // sessionIds is cwd-filtered
setTitle(title), attachSession(id), insertSessionBefore(id, beforeId),
detachSession(id), status(): Promise<'ok' | 'missing-dir'>
```

**Identity and label convention.** Two distinct things — do not conflate them like the
current code does:

- **Identity** = `workspace.id` (`WorkspaceId`-branded), durable, survives rename. This is
  the key the phone should send back.
- **Path** = `record.path`, the `fs.realpath` **canonical** path; uniqueness is string
  equality of canonical paths (`dsh-workspace/README.md:91`). A symlink to an owned
  directory collides.
- **Label** = `workspace.title`. Default title on creation is the **final path segment**
  (`basename`, falling back to the filesystem root):
  `pathApi.basename(path) || pathApi.parse(path).root` (`dsh-workspace/lib/index.js:31-34`).
  Titles are not unique (`create` JSDoc: "Different canonical paths may share a display title").

The shipped controller's authoritative client projection — mirror this exactly:

```js
function workspaceView(workspace) {
  return { workspaceId: workspace.id, path: workspace.path, title: workspace.title,
           sessionIds: [...workspace.sessionIds],
           createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }
}
```
`dsh-api-workspace-controller/lib/index.js:17-25`, exposed via
`this.ctx.workspaceRegistry.list().map(workspaceView)` (`:68`).

So `workspaceKeyFor(path, identity)` in the current code should become
`workspace.id ?? workspace.path`, and the label should be `workspace.title`, not the last
path segment. Note the registry holds **no** workspace for a cwd never registered — the
current "derive workspaces from distinct session cwds" fallback is not equivalent to the
registry list.

---

## 7. The plugin context surface

### Declaring needs

The idiom is module-level exports from your plugin entry (already correct in
`dsh-remote-control/src/index.ts`):

```ts
export const name = 'dsh-remote-control'
export const inject = ['webServer', 'sessions']
```

Inside a plugin you can also do optional/dynamic acquisition:

```ts
ctx.inject(['sessionPersistence'], (scoped) => { ... })   // optional, scoped
ctx.get('sessionQuery')                                    // optional lookup, may be undefined
```
Both patterns appear in shipped code, e.g. `dsh-session-query/lib/index.js:82-84`
(`_ctx.inject(["sessionPersistence"], ...)`) and the controller's
`this.ctx.get("sessionTitle")` (`dsh-api-session-controller/lib/index.js:756`).

### Exact service key strings

Mechanically extracted from every `super(ctx, "<key>")` in the shipped tree:

| Need | Key |
|---|---|
| session store | `sessions` |
| query / history | `sessionQuery` |
| titles | `sessionTitle` |
| projections | `sessionProjections` |
| agents (send/cancel/create) | `agents` |
| **approvals** | `approval` |
| workspaces | `workspaceRegistry` |
| ask-user questions | `userQuestions` |
| persistence | `sessionPersistence` |
| tools / llm | `tools`, `llm` |
| http server (yours) | `webServer` |
| permissions | `authorization`, `permissionPresets` |
| jobs / subagents | `jobs`, `subagents` |

There is **no** `ctx.agent`, `ctx.workspace`, `ctx.session`, or `ctx.approvals`.
(`ctx.workspaces` and `ctx.remote` exist only on the *client* side.)

Suggested `inject` for a phone remote-control host plugin:

```ts
export const inject = ['webServer', 'sessions', 'agents', 'sessionQuery', 'approval']
// add 'sessionTitle' | 'workspaceRegistry' | 'sessionPersistence' if you use them,
// but treat workspaceRegistry and sessionTitle as optional (not in dsh-base).
```

### Events to subscribe to (listener signature + payload)

Register with `{ global: true }` — that is what the shipped controller does for the
session/agent feed (`dsh-api-session-controller/lib/types/history.js:158` for
`session/event`, `:181` for `agent/assistant-stream`).

| Event | Listener signature | Mode | Evidence |
|---|---|---|---|
| `session/event` | `(session: Session, event: SessionEvent) => void` | emit | `dsh-session/lib/types/index.d.ts` Events |
| `session/created` | `(session: Session) => void` | emit | same |
| `session/disposed` | `(session: Session) => void` | emit | same |
| `session/flush` | `(session: Session) => Promise<void>\|void` | parallel | same |
| `agent/assistant-stream` | `({agent, frame}: {agent: Agent; frame: AssistantStreamFrame}) => void` | emit | `dsh-agent/lib/types/runtime-types.d.ts:106-140` |
| `agent/status` | `({agent, status}: {agent: Agent; status: 'idle'\|'running'}) => void` | emit | `runtime-types.d.ts` Events |
| `agent/created` | `({agent, source, signal?}) => undefined\|Promise<undefined>` | **serial** | `runtime-types.d.ts:227-232` |
| `agent/disposed` | `({agent}) => void` | emit | `runtime-types.d.ts` Events |
| `agent/error` | `({agent, turn, step, error}) => void` | emit | `dsh-agent-loop/lib/index.js:880` |
| `agent/inbox/inserted` | `({agent, message}) => void` | emit | `runtime-types.d.ts` Events |
| `agent/inbox/claimed` | `({agent, message, turn}) => void` | emit | same |
| `agent/inbox/discarded` | `({agent, message}) => void` | emit | same |
| `agent/pre-step` | `({agent, messages, turn, step, signal}, next) => Promise<PreStepDecision>` | waterfall | same |
| `agent/request` | `({agent, turn, step, signal}, next) => Promise<LlmCallConfig>` | waterfall | same |
| `agent/request-error` | `(payload, next) => Promise<RequestErrorAction>` | waterfall | same |
| `approval/request` | `(req: ApprovalRequestEvent, next) => Promise<ApprovalOutcome>` | waterfall | `dsh-user-approval/lib/types/types.d.ts` |
| `user-questions/request` | `(request, next)` | waterfall | `dsh-user-questions/lib/index.js:681` |
| `turn/start`, `turn/end`, `step/start`, `step/end` | session events (via `session/event`) | log | `dsh-session/lib/types/types.d.ts:255-286` |

**Minimal delta-push loop for the phone:** subscribe to `session/event` for durable
transcript deltas (filter by `session.id`, forward `{type, seq, time, data}`), subscribe to
`agent/assistant-stream` for live typing, and subscribe to `agent/status` +
`turn/end` for run-state. `session/event` is described as a "Post-commit, fire-and-forget
append feed… callbacks run after [the log push]" (`dsh-session/lib/types/index.d.ts` Events
JSDoc), so it is safe to forward immediately.

`session/event` is scope-filtered: agent-scoped listeners receive only sessions entered
through that agent's context — hence `{ global: true }` for a host-wide view.

### TypeScript types to import

```ts
import type { Context } from '@deepseek-ai/cordis'          // service keys via module merging
import type {} from '@deepseek-ai/dsh-session'              // augments Context.sessions + Events
import type {} from '@deepseek-ai/dsh-agent'                // augments Context.agents + agent/* Events
import type {} from '@deepseek-ai/dsh-user-approval/types'  // augments approval/request; ApprovalOutcome
import type {} from '@deepseek-ai/dsh-session-query'        // augments Context.sessionQuery

import type { Session, SessionHeader, SessionEvent, SessionEventType,
              UserMessage, AssistantMessage, ToolResultMessage,
              AgentCancelCause, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle, AgentOptions, AgentStatus, CancelOptions,
              Inbox, InboxTarget, AssistantStreamFrame,
              SessionStartSource, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { SessionRecord, SessionSurfaceSnapshot, SessionLogSnapshot,
              SessionEventRecord, SessionObservation,
              SessionResultFilter, SessionEventResultFilter } from '@deepseek-ai/dsh-session-query'
import type { Message, ToolCallId } from '@deepseek-ai/dsh-llm'      // Message is re-exported here,
import { createUserMessage } from '@deepseek-ai/dsh-llm'   // NOT from dsh-session
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
```

The `import type {} from '...'` lines are load-bearing: they pull in the
`declare module '@deepseek-ai/cordis'` augmentation that makes `ctx.sessionQuery` etc. typed.

Pin `0.2.1-rc.3` to match the installed host — the asar and these declarations are the same
version, so a newer minor could drift.

---

## 8. Could not determine (do not guess these)

1. **Full `AgentCancelCause` union.** Only `{kind:'disposed'}` and `{kind:'user'}` were
   observed (`dsh-agent-loop/lib/index.js:885`, README). I did not open the declaration
   that defines the complete union. `{ kind: 'user' }` is confirmed by the README.
2. **Whether an `approval/request` listener must pass `{ global: true }`.** The typed
   declaration is `this: Scoped<Agent>`; agent-scoped dispatch filters by agent. The shipped
   *consumers* of the session/agent feed all pass `{ global: true }`, and no shipped host
   answerer without it was found — but the shipped browser answerer goes through the remote
   bridge, so it is not a direct precedent. **Verify empirically before relying on it.**
3. **A public session-delete method.** `ctx.sessions` has none; `workspaceRegistry.delete`
   is workspace-only; persistence deletion exists but I did not confirm its method name.
4. **`UserQuestionRequest` field shape** (`user-questions/request` payload) — not
   enumerated. Relevant only if the phone must answer `ask_user_question`.
5. **`WorkspaceId` brand definition** — the brand exists and `workspace.id` is the identity,
   but I did not read its declaration site or confirm whether ids are stable across
   registry rebuilds (the README implies yes: "records its identity durably… renaming keeps
   that identity").
6. **Any public paging API for the session *list*.** None found; paging exists for
   *history* (`readEvent` before/after, `beforeSeq`/`maxMessages`/`turnWindow`).
7. **Exact runtime behavior of `ctx.sessionQuery` when `dsh-session-query` is unmounted.**
   It is an abstract service requiring a mounted backend (shipped: `dsh-session-query-sqlite`);
   `dsh-session-query/README.md` says the package is "never mounted alone". The shipped
   controller soft-checks with `ctx.get('sessionQuery')` and throws
   `gateway/internal` when absent (`dsh-api-session-controller/lib/index.js:1932-1934`).
8. **`dsh-agent-loop` `maxParallelToolCalls` / other config** — out of scope, not verified.
9. **Stability classification.** Nothing is marked deprecated in the packages used here, but
   the version is a release candidate (`0.2.1-rc.3`) and the READMEs carry "Known
   Limitations" rather than compatibility promises. Treat all of this as
   **internal-but-public API pinned to a release candidate**.