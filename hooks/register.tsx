import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Meter, MeterEnd, MeterStop } from '../types'

const FRESH: Meter = {
  sessionId: null,
  firstPromptAt: null,
  isFirstPromptEstimate: false,
  pendingAt: null,
  isPendingPersons: false,
  isPendingCommand: false,
  runningSince: null,
  lastEndedAt: null,
  lastMs: null,
  lastEnd: null,
  workMs: 0,
  stretches: 0,
  stoppedAt: null,
  stoppedBy: null,
  pausedMs: 0,
}

// Change the tag when Meter's fields change: new code then declines what an
// earlier version stored, which outlives a reload, and the session's figures
// load again from the store.
const meter = atom({ plugin: 'session-meter', key: 'meter' } as const, FRESH, {
  shape: 'meter-6',
})
// The timer writes the time here; the band reads it, so each beat redraws it.
const beat = atom({ plugin: 'session-meter', key: 'beat' } as const, 0)

/** Claude waiting on the person this long after a response stops the meter: they're away. */
const AWAY_MS = 30 * 60_000
/** A turn starting this soon after the last one ended continues it (a Stop hook's follow-up). */
const FOLLOW_UP_MS = 3_000
/** How long a sent prompt waits for its turn; a command that starts none is forgotten. */
const PENDING_MS = 30_000
/** The band's redraw pace: every second while a live count reads to the second, else slower. */
const FAST_BEAT_MS = 1_000
const SLOW_BEAT_MS = 15_000
/** The wait on the person reads to the second this long after a response, then in minutes. */
const SECONDS_WAIT_MS = 180_000
/** Sessions kept in the store; past this the oldest are dropped. */
const KEEP_SESSIONS = 1_500
/**
 * Where a send of the person's comes from: typed at the terminal, the desktop
 * app (an SDK host), or the phone through Remote Control. A task's
 * notification, a scheduled trigger or another session's message neither
 * starts the count nor picks a stopped one back up, though in a running count
 * the work it starts is Claude's.
 */
const PERSONS: ReadonlySet<string> = new Set(['composer', 'sdk', 'bridge'])

/** What the store keeps per session, so a resumed session picks up its count. */
type Saved = Pick<
  Meter,
  | 'firstPromptAt'
  | 'isFirstPromptEstimate'
  | 'lastEndedAt'
  | 'lastMs'
  | 'lastEnd'
  | 'workMs'
  | 'stretches'
  | 'stoppedAt'
  | 'stoppedBy'
  | 'pausedMs'
>

const storeKey = (sessionId: string) => `s:${sessionId}`

const isTime = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value))

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const ENDS: readonly MeterEnd[] = ['answer', 'aborted', 'refusal', 'error']
const STOPS: readonly MeterStop[] = ['you', 'away']

// A session's saved count, or null for anything else. Records from earlier
// versions load too: the figures they kept that are no longer used are set
// aside, one with no stop on it is running, and one with no stopped time
// recorded has none.
const fromStore = (value: unknown): Saved | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const isWhole =
    isTime(v.firstPromptAt) &&
    typeof v.isFirstPromptEstimate === 'boolean' &&
    isTime(v.lastEndedAt) &&
    isTime(v.lastMs) &&
    (v.lastEnd === null || ENDS.includes(v.lastEnd as MeterEnd)) &&
    isCount(v.workMs) &&
    isCount(v.stretches)
  if (!isWhole) return null
  return {
    firstPromptAt: v.firstPromptAt as number | null,
    isFirstPromptEstimate: v.isFirstPromptEstimate as boolean,
    lastEndedAt: v.lastEndedAt as number | null,
    lastMs: v.lastMs as number | null,
    lastEnd: v.lastEnd as MeterEnd | null,
    workMs: v.workMs as number,
    stretches: v.stretches as number,
    stoppedAt: isTime(v.stoppedAt) ? v.stoppedAt : null,
    stoppedBy: STOPS.includes(v.stoppedBy as MeterStop) ? (v.stoppedBy as MeterStop) : null,
    pausedMs: isCount(v.pausedMs) ? Math.max(0, v.pausedMs) : 0,
  }
}

// No count yet in this session: nothing the meter has seen to count from.
const isEmpty = (m: Meter): boolean =>
  m.firstPromptAt === null && m.runningSince === null && m.lastEndedAt === null

// A send still waiting for its turn: its time, or null. A slash command (it
// may start no turn) or a send whose turn never came leaves Claude waiting.
const sentAt = (m: Meter, now: number): number | null =>
  m.pendingAt !== null && !m.isPendingCommand && now - m.pendingAt <= PENDING_MS
    ? m.pendingAt
    : null

// Where the count stopped, or null while it runs: the person's stop, or the
// away catch once Claude has waited on them for the cutoff with no send.
const stopOf = (m: Meter, now: number): { at: number; by: MeterStop } | null => {
  if (m.stoppedAt !== null) return { at: m.stoppedAt, by: m.stoppedBy ?? 'you' }
  if (m.runningSince !== null || m.lastEndedAt === null) return null
  const until = sentAt(m, now) ?? now
  return until - m.lastEndedAt >= AWAY_MS ? { at: m.lastEndedAt + AWAY_MS, by: 'away' } : null
}

// Picks a stopped count back up at `at`, where it left off: the time it spent
// stopped goes into pausedMs, which every total leaves out, and Claude's wait
// on the person (or the stretch a send starts) runs from `at`. A count with no
// first send yet (only Claude's own turns so far) starts its Total time here.
const resumed = (m: Meter, stoppedAt: number, at: number) => ({
  stoppedAt: null,
  stoppedBy: null,
  firstPromptAt: m.firstPromptAt ?? at,
  pausedMs: m.firstPromptAt === null ? m.pausedMs : m.pausedMs + Math.max(0, at - stoppedAt),
  lastEndedAt: at,
  lastMs: null,
  lastEnd: null,
})

// No beat for a stopped count; every second while Claude works, a sent
// prompt waits for its turn, or a response ended in the last three minutes;
// every fifteen seconds otherwise, until the away catch stops it.
const paceFor = (m: Meter, now: number): number => {
  if (stopOf(m, now) !== null) return 0
  if (isEmpty(m)) return 0
  return m.runningSince !== null ||
    sentAt(m, now) !== null ||
    (m.lastEndedAt !== null && now - m.lastEndedAt < SECONDS_WAIT_MS)
    ? FAST_BEAT_MS
    : SLOW_BEAT_MS
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A live count to the second: s, m s, h m s. */
const secondsLength = (ms: number): string => {
  const whole = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`
  if (m > 0) return `${m}m ${pad(s)}s`
  return `${s}s`
}

const wholeMinutes = (ms: number): number => Math.floor(Math.max(0, ms) / 60_000)

/** A count of whole minutes: m, h m, d h m. */
const minutesText = (minutes: number): string => {
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`
  if (h > 0) return `${h}h ${pad(m)}m`
  return `${m}m`
}

/** A running total: seconds in the first minute, then whole minutes. */
const totalLength = (ms: number): string =>
  ms < 60_000 ? `${Math.floor(Math.max(0, ms) / 1000)}s` : minutesText(wholeMinutes(ms))

// The beat's timer. A reload drops it, with the module, and session.start
// starts it again.
let timer: Timer | undefined
let pace = 0

// Every change to the figures runs here, one after another in the order the
// events came, so a turn's start never reads them before its prompt's write
// lands. A change that fails is dropped: the meter never holds up a session.
let queue: Promise<unknown> = Promise.resolve()

function inOrder<T>(work: () => Promise<T>): Promise<T | undefined> {
  const run = queue.then(work).catch(() => undefined)
  queue = run
  return run
}

// Sets the beat's pace; 0 stops it, so a stopped count runs nothing.
function keepTime($: EngineInterface, ms: number) {
  if (ms === pace && (ms === 0 || timer !== undefined)) return
  timer?.cancel()
  timer = undefined
  pace = ms
  if (ms > 0) timer = $.clock.every(ms, () => void inOrder(() => markBeat($)))
}

// One beat: redraw; record the away catch once it falls due; slow down, or
// stop, once nothing reads to the second.
async function markBeat($: EngineInterface) {
  const now = await $.clock.now()
  await update($, beat, () => now)
  const m = await settleAway($, await read($, meter), now)
  keepTime($, paceFor(m, now))
}

// Writes down the away catch once it has fallen due, so the stop is on record.
async function settleAway($: EngineInterface, m: Meter, now: number): Promise<Meter> {
  const stop = stopOf(m, now)
  if (stop === null || m.stoppedAt !== null) return m
  const stopped = await update($, meter, n => ({ ...n, stoppedAt: stop.at, stoppedBy: stop.by }))
  await save($, stopped)
  return stopped
}

// This session's count. The first read in a session loads it from the
// store (a resumed or restarted session) or starts empty: a session the meter
// has seen no send in shows nothing until the next one. A new session id (a
// /clear, a resume) loads afresh.
async function current($: EngineInterface): Promise<Meter> {
  const sessionId = await $.session.id()
  const held = await read($, meter)
  if (held.sessionId === sessionId) return held

  const saved = fromStore(await $.store.get(storeKey(sessionId)))
  const fresh: Meter = { ...FRESH, ...(saved ?? {}), sessionId }

  return update($, meter, now => (now.sessionId === sessionId ? now : fresh))
}

async function save($: EngineInterface, m: Meter) {
  if (m.sessionId === null) return
  const saved: Saved = {
    firstPromptAt: m.firstPromptAt,
    isFirstPromptEstimate: m.isFirstPromptEstimate,
    lastEndedAt: m.lastEndedAt,
    lastMs: m.lastMs,
    lastEnd: m.lastEnd,
    workMs: m.workMs,
    stretches: m.stretches,
    stoppedAt: m.stoppedAt,
    stoppedBy: m.stoppedBy,
    pausedMs: m.pausedMs,
  }
  await $.store.set(storeKey(m.sessionId), saved)
}

// The session's count, the beat, and a trim of the store.
async function openSession($: EngineInterface) {
  const now = await $.clock.now()
  const m = await settleAway($, await current($), now)
  keepTime($, paceFor(m, now))
  const keys = await $.store.keys()
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_SESSIONS))) {
    await $.store.delete(key)
  }
}

// A send made while Claude is idle: it ends the wait once a turn takes it up.
// A later send before that turn starts (a command that started none) takes
// its place. One typed over a running turn joins that turn's stretch.
async function notePrompt(
  $: EngineInterface,
  now: number,
  isPersons: boolean,
  isFromIdle: boolean,
  isCommand: boolean,
) {
  await current($)
  const after = await update($, meter, m =>
    isFromIdle && m.runningSince === null
      ? { ...m, pendingAt: now, isPendingPersons: isPersons, isPendingCommand: isCommand }
      : m,
  )
  keepTime($, paceFor(after, now))
}

async function noteTurnStart($: EngineInterface, now: number) {
  const before = await current($)
  const after = await update($, meter, m => {
    if (m.runningSince !== null) return m
    const isFreshSend = m.pendingAt !== null && now - m.pendingAt <= PENDING_MS
    const start = isFreshSend && m.pendingAt !== null ? m.pendingAt : now
    const isPersons = isFreshSend && m.isPendingPersons
    const cleared = { pendingAt: null, isPendingPersons: false, isPendingCommand: false }

    // A stopped count: the person's own send picks it back up where it left
    // off, Claude's stretch running from the send; a turn Claude starts on its
    // own passes unmetered.
    const stop = stopOf(m, now)
    if (stop !== null) {
      if (!isPersons) return { ...m, ...cleared }
      return { ...m, ...cleared, ...resumed(m, stop.at, start), runningSince: start }
    }

    const first =
      m.firstPromptAt === null && isPersons
        ? { firstPromptAt: start, isFirstPromptEstimate: false }
        : {}
    if (isFreshSend) return { ...m, ...cleared, ...first, runningSince: start }
    // A turn right on the heels of the last (a Stop hook sent Claude back to
    // work, or a prompt queued during it) reopens that stretch, so its length
    // runs from the prompt that started it and the moment between stays Claude's.
    if (m.lastEndedAt !== null && m.lastMs !== null && now - m.lastEndedAt <= FOLLOW_UP_MS) {
      return {
        ...m,
        ...cleared,
        runningSince: m.lastEndedAt - m.lastMs,
        workMs: m.workMs - m.lastMs,
        stretches: m.stretches - 1,
      }
    }
    // A turn that starts on its own (a task's notification, a wake-up):
    // Claude's time from now.
    return { ...m, ...cleared, runningSince: now }
  })
  const isNewRecord =
    after.firstPromptAt !== before.firstPromptAt ||
    after.pausedMs !== before.pausedMs ||
    after.stoppedAt !== before.stoppedAt
  if (isNewRecord) await save($, after)
  keepTime($, paceFor(after, now))
}

async function noteTurnEnd($: EngineInterface, now: number, reason: MeterEnd, durationMs: number) {
  await current($)
  const done = await update($, meter, m => {
    // A turn the meter left unmetered in a stopped count.
    if (m.runningSince === null && stopOf(m, now) !== null) return m
    // A turn whose start the meter missed (it loaded mid-turn) takes the
    // engine's own length for it.
    const since = m.runningSince ?? now - durationMs
    const ms = Math.max(0, now - since)
    return {
      ...m,
      runningSince: null,
      pendingAt: null,
      isPendingPersons: false,
      isPendingCommand: false,
      lastEndedAt: now,
      lastMs: ms,
      lastEnd: reason,
      workMs: m.workMs + ms,
      stretches: m.stretches + 1,
    }
  })
  await save($, done)
  keepTime($, paceFor(done, now))
}

/** What a stop came to, for the command's answer. */
type StopResult = 'stopped' | 'working' | 'already' | 'nothing'

// The person stops the count now: the totals freeze and the beat stops,
// until Start again or their next send picks it back up.
async function stopNow($: EngineInterface): Promise<StopResult> {
  const now = await $.clock.now()
  const m = await current($)
  if (m.runningSince !== null) return 'working'
  if (stopOf(m, now) !== null) return 'already'
  if (m.firstPromptAt === null && m.lastEndedAt === null) return 'nothing'
  const stopped = await update($, meter, n => ({
    ...n,
    pendingAt: null,
    isPendingPersons: false,
    isPendingCommand: false,
    stoppedAt: now,
    stoppedBy: 'you' as const,
  }))
  await save($, stopped)
  keepTime($, 0)
  return 'stopped'
}

// The person starts the count at the click. Start, in a session with none yet,
// begins it from zero; Start again picks a stopped one back up where it left
// off. Either way Claude waits on them from the click.
async function startCount($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  const m = await current($)
  const stop = stopOf(m, now)
  if (!isEmpty(m) && stop === null) return false
  const started = await update($, meter, n =>
    isEmpty(n) || stop === null
      ? { ...FRESH, sessionId: n.sessionId, firstPromptAt: now, lastEndedAt: now }
      : {
          ...n,
          pendingAt: null,
          isPendingPersons: false,
          isPendingCommand: false,
          ...resumed(n, stop.at, now),
        },
  )
  await save($, started)
  keepTime($, paceFor(started, now))
  return true
}

async function forget($: EngineInterface) {
  await update($, meter, () => FRESH)
}

const STOP_ANSWERS: Record<StopResult, string> = {
  stopped: 'Session meter stopped. Start again or your next prompt picks it up where it left off.',
  working: 'Claude is still working. Stop the meter once it finishes.',
  already: 'The session meter is already stopped.',
  nothing: 'The session meter has nothing running yet.',
}

export const register: Register = on => {
  // Registers /stop-meter, then opens the session on a timer, off the hook,
  // so the first prompt never waits on the meter.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stop-meter',
      description: 'Stop the session meter now; your next prompt picks it back up',
    })
    const started = await next(e)
    $.clock.after(1, () => void inOrder(() => openSession($)))

    return started
  })

  on('command.run', { command: 'stop-meter' }, async $ => {
    const result = await inOrder(() => stopNow($))

    return { text: STOP_ANSWERS[result ?? 'nothing'] }
  })

  // Each hook below reads the time first, lets the event go on at once, and
  // writes its figures alongside: the meter never holds up a prompt or a turn.
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const isPersons = e.isMeta !== true && PERSONS.has(e.origin?.kind ?? 'composer')
    const isCommand = e.command !== undefined
    const noted = inOrder(() =>
      notePrompt($, now, isPersons, e.turnId === undefined, isCommand),
    )
    const entered = await next(e)
    await noted

    return entered
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const noted = inOrder(() => noteTurnStart($, now))
    const started = await next(e)
    await noted

    return started
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const noted = inOrder(() => noteTurnEnd($, now, e.reason, e.durationMs))
    const answered = await next(e)
    await noted

    return answered
  })

  // A /clear or a resume puts another session in this process: start over,
  // and the next read loads that session's own figures.
  on('session.end', async ($, e, next) => {
    const isAnother = e.reason === 'clear' || e.reason === 'resume'
    const noted = isAnother ? inOrder(() => forget($)) : undefined
    const ended = await next(e)
    await noted

    return ended
  })

  // One line, in this order: the wait on the person now (Been waiting), the
  // wait on them in all, Claude's time in all (Claude thinking), and the
  // count's time in all (Total time), the time it spent stopped left out.
  // Every counted moment is one or the other, so the wait in all is that time
  // less Claude's, and the totals shown add up to the last. A stopped count
  // shows its totals frozen at the stop, and Start again, which picks them
  // back up, in place of Stop.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const m = await read($, meter)
    await read($, beat)
    const { Box, Button, Text } = $.ui.resolve(e)

    // A session with no count yet: the line, still, and nothing running.
    // Start, or the person's next send, begins the count.
    if (isEmpty(m)) {
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text dimColor>Not started</Text>
          <Button key="start" onPress={() => void inOrder(() => startCount($))}>
            <Text size="footnote">Start</Text>
          </Button>
        </Box>
      )
    }

    const now = await $.clock.now()
    const stop = stopOf(m, now)
    const at = stop?.at ?? now
    const sent = stop === null ? sentAt(m, now) : null
    // The wait under way: live from the last response's end until the person
    // sends, or until the count stopped.
    const waited =
      m.runningSince === null && m.lastEndedAt !== null
        ? Math.max(0, (sent ?? at) - m.lastEndedAt)
        : 0
    const thinkMs = m.workMs + (m.runningSince === null ? 0 : at - m.runningSince)

    const parts: { label: string; value?: string }[] = []
    if (stop !== null) {
      parts.push({ label: stop.by === 'you' ? 'Stopped' : 'Away' })
    } else {
      const isWaiting = m.runningSince === null && m.lastEndedAt !== null && sent === null
      let wait = '0s'
      if (isWaiting) {
        wait = waited < SECONDS_WAIT_MS ? secondsLength(waited) : totalLength(waited)
      }
      parts.push({ label: 'Been waiting', value: wait })
    }

    const mark = m.isFirstPromptEstimate ? '~' : ''
    let waitTotal = totalLength(waited)
    let since: string | null = null
    if (m.firstPromptAt !== null) {
      const sinceMs = Math.max(0, at - m.firstPromptAt - m.pausedMs)
      const waitMs = Math.max(0, sinceMs - thinkMs)
      // In whole minutes, the wait is the minutes shown for the count less
      // those shown for Claude, so the three read as a sum.
      waitTotal =
        mark +
        (waitMs < 60_000
          ? totalLength(waitMs)
          : minutesText(Math.max(0, wholeMinutes(sinceMs) - wholeMinutes(thinkMs))))
      since = mark + totalLength(sinceMs)
    }
    parts.push({ label: 'Total waiting on you', value: waitTotal })
    parts.push({ label: 'Claude thinking', value: totalLength(thinkMs) })
    if (since !== null) parts.push({ label: 'Total time', value: since })

    const canStop = stop === null && m.runningSince === null && m.lastEndedAt !== null

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {parts.map((part, i) => (
          <Box key={part.label} flexDirection="row" columnGap={1}>
            {i > 0 && <Text dimColor>·</Text>}
            <Text dimColor>{part.label}</Text>
            {part.value !== undefined && <Text tabular>{part.value}</Text>}
          </Box>
        ))}
        {canStop && (
          <Button key="stop" onPress={() => void inOrder(() => stopNow($))}>
            <Text size="footnote">Stop</Text>
          </Button>
        )}
        {stop !== null && (
          <Button key="start" onPress={() => void inOrder(() => startCount($))}>
            <Text size="footnote">Start again</Text>
          </Button>
        )}
      </Box>
    )
  })
}
