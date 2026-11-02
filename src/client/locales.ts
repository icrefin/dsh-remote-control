/**
 * The panel's copy, in the two languages the shipped web client ships.
 *
 * `dshRemoteControl` is this plugin's locale namespace: `ctx.locale.register`
 * publishes the dictionaries and `ctx.locale.bind` hands out a translate seat
 * bound to them. A locale revision re-renders every registered slot, so the
 * panel never caches a translated string.
 *
 * @module dsh-remote-control/client/locales
 */

/** English copy. */
export const en = {
  panel: 'Remote Control',
  title: 'Remote Control',
  description:
    'Pair a browser with this host through the relay. It then runs the real Harness client, tunnelled to this machine — every panel, approval and setting included.',
  enable: 'Start',
  disable: 'Stop',
  starting: 'Working…',
  loading: 'Contacting the host…',
  refresh: 'Refresh',
  newToken: 'New link',
  tokenExpires: 'Pairing link expires in',
  failed: 'The host refused the request',
  idleHint: 'Remote control is off. Start opens an outbound connection to the relay and pairs a browser to this host; Stop ends that pairing, and browsers already paired must pair again.',
  linkLifetime: 'A link is single-use and short-lived on purpose; it is a credential you may have shared. A browser that has already paired is unaffected — restarting the app does not unpair it, and only Stop does.',
  scanHint: 'Scan this with a phone camera, or open the link in any browser.',
  pairedHint: 'A browser is connected.',
  waitingHint: 'Waiting for a browser to open the link.',
  copyLink: 'Copy link',
  copied: 'Copied',
  relay: 'Relay',
  phase: 'Phase',
  session: 'Session',
  browser: 'Browser',
  connected: 'connected',
  disconnected: 'not connected',
  messages: 'Activity',
  requests: 'Tunnel frames',
  errors: 'Failed frames',
  reconnects: 'Reconnects',
  relayMissing: 'No relay configured. Enter the origin of the relay you deployed.',
  relaySetting: 'Relay server',
  relaySettingHint:
    'The origin of your own relay, e.g. https://relay.example or http://192.0.2.10:8080. Saved for the next start.',
  relayPlaceholder: 'https://relay.example',
  relaySave: 'Save',
  secretSetting: 'Relay secret',
  secretPlaceholder: 'the secret your relay was started with',
  secretSet: 'set',
  secretUnset: 'not set',
  secretSave: 'Save secret',
  secretShow: 'Show the secret',
  secretHide: 'Hide the secret',
  secretMissing: 'No secret yet — paste the one your relay was started with.',
  secretHint: 'Kept in ~/.dsh/relay-secret, never in your profile. Checked against the relay when you save it, so a wrong value is reported instead of silently stored. Leave it empty to clear. The relay refuses to register a host without this. It is stored in your profile and never shown again; leave it empty to clear.',
  test: 'Test connection',
  testing: 'Testing…',
  testTitle: 'Connection test',
  testPassed: 'Every step passed.',
  testFailed: 'Something in the chain is not working.',
  check_configured: 'Relay configured',
  check_reachable: 'Relay reachable',
  check_version: 'Versions match',
  check_attached: 'Host socket attached',
  check_session: 'Relay sees this session',
  check_roundtrip: 'Round trip through the tunnel',
  checkSkipped: 'not attempted',
  relaySaving: 'Saving…',
  relaySaved: 'Saved',
  relayLockedByEnv: 'Pinned by DSH_REMOTE_RELAY in the environment; unset it to edit here.',
  relayLockedByComposition:
    'This composition has no settings service, so the origin cannot be saved here. Set the `relay` config in your profile patch.',
  relaySourceEnv: 'from DSH_REMOTE_RELAY',
  relaySourcePatch: 'saved to your profile',
  authenticated: 'Harness session',
  authenticatedYes: 'minted',
  authenticatedNo: 'unavailable',
  authMissingHint:
    'This composition has no Connection service, so the tunnel cannot mint the browser session the Harness requires. Tunnelled pages will load, but calls to /api will be refused.',
  inFlight: 'In flight',
  displayWidth: 'Fit threshold',
  trustNote:
    'The pairing link is a credential: anyone who opens it reaches this host. Stop ends the pairing and invalidates every browser already paired to it.',
}

/** Simplified Chinese copy. Typed against `en`, so a missing key fails the build. */
export const zh: typeof en = {
  panel: '远程控制',
  title: '远程控制',
  description:
    '让浏览器通过中继与主机配对，随后即可运行真正的 Harness 客户端——所有面板、审批与设置都与本机一致。',
  enable: '开始',
  disable: '停止',
  starting: '处理中…',
  loading: '正在请求主机…',
  refresh: '刷新',
  newToken: '新链接',
  tokenExpires: '配对链接剩余有效期',
  failed: '主机拒绝了该请求',
  idleHint: '远程控制未开启。开启后会向中继发起一条出站连接。',
  linkLifetime: '链接是单次使用且短时效的凭证——它可能被转发或截图。已经配对过的浏览器不受影响：重启应用不会解除配对，只有“停止”会。',
  scanHint: '用手机相机扫描，或在任意浏览器中打开该链接。',
  pairedHint: '已有浏览器连接。',
  waitingHint: '等待浏览器打开链接。',
  copyLink: '复制链接',
  copied: '已复制',
  relay: '中继',
  phase: '状态',
  session: '会话',
  browser: '浏览器',
  connected: '已连接',
  disconnected: '未连接',
  messages: '活动',
  requests: '隧道帧',
  errors: '失败帧',
  reconnects: '重连次数',
  relayMissing: '尚未配置中继。请输入你自建中继的地址。',
  relaySetting: '中继服务器',
  relaySettingHint: '你自建中继的源地址，例如 https://relay.example 或 http://192.0.2.10:8080。保存后下次启动仍然生效。',
  relayPlaceholder: 'https://relay.example',
  relaySave: '保存',
  secretSetting: '中继密钥',
  secretPlaceholder: '中继启动时设置的密钥',
  secretSet: '已设置',
  secretUnset: '未设置',
  secretSave: '保存密钥',
  secretShow: '显示密钥',
  secretHide: '隐藏密钥',
  secretMissing: '尚未设置密钥——请粘贴中继启动时使用的密钥。',
  secretHint: '保存在 ~/.dsh/relay-secret，不写入配置文件。保存时会与中继校验，因此错误的值会被立即报出。留空表示清除。中继在未收到该密钥时会拒绝注册主机。密钥保存在你的配置中，之后不再显示；留空表示清除。',
  test: '测试连接',
  testing: '测试中…',
  testTitle: '连接测试',
  testPassed: '所有步骤均已通过。',
  testFailed: '链路上有环节未通过。',
  check_configured: '已配置中继',
  check_reachable: '中继可达',
  check_version: '版本一致',
  check_attached: '主机套接字已连接',
  check_session: '中继可见本会话',
  check_roundtrip: '隧道往返',
  checkSkipped: '未执行',
  relaySaving: '保存中…',
  relaySaved: '已保存',
  relayLockedByEnv: '已被环境变量 DSH_REMOTE_RELAY 固定；取消该变量后才能在此编辑。',
  relayLockedByComposition: '该组合没有 settings 服务，无法在此保存。请在 profile patch 中设置 `relay` 配置。',
  relaySourceEnv: '来自 DSH_REMOTE_RELAY',
  relaySourcePatch: '已保存到 profile',
  authenticated: 'Harness 会话',
  authenticatedYes: '已签发',
  authenticatedNo: '不可用',
  authMissingHint:
    '该组合中没有 Connection 服务，隧道无法签发 Harness 所需的浏览器会话。页面仍可加载，但对 /api 的调用会被拒绝。',
  inFlight: '进行中',
  displayWidth: '缩放阈值',
  trustNote: '配对链接本身即凭证：任何打开它的人都能访问这台主机。「停止」会结束本次配对，并使所有已配对的浏览器失效。',
}

/**
 * Translate one key of this panel's dictionary.
 *
 * Every child component accepts exactly this shape, so the panel can pass its
 * translate seat down without repeating the framework's generic machinery.
 */
export type PanelTranslate = (key: keyof typeof en) => string