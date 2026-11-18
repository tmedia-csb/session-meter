import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const T0 = Date.UTC(2026, 10, 17, 21, 0, 0)
const MIN = 60_000

const BAND = {
  plugin: 'session-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Session = { id: string; turns: number; startedAt: number }

// What the engine answers beneath the plugin, which a test stands in for.
function engine(on: On, session: Session) {
  on('session.id', () => ({ value: session.id }))
  on('session.turns', () => ({ value: session.turns }))
  on('session.usage', () => ({
    value: { startedAt: session.startedAt } as SessionUsage,
  }))
  on('command.register', () => ({ value: { command: 'stop-meter' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

type Origin = 'composer' | 'sdk' | 'bridge' | 'task-notification'

// A prompt as the engine raises it: the desktop app's own arrive as `sdk`,
// and a slash command carries its name.
function sent(text: string, extra: { turnId?: string; origin?: Origin; command?: string } = {}) {
  return {
    text,
    wait: false,
    origin: { kind: extra.origin ?? 'sdk' },
    ...(extra.turnId === undefined ? {} : { turnId: extra.turnId }),
    ...(extra.command === undefined ? {} : { command: { name: extra.command, args: '' } }),
  } as const
}

// /stop-meter as the person runs it.
const STOP = {
  command: 'stop-meter',
  args: '',
  origin: { kind: 'sdk' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

function finished(turnId: string, durationMs: number, reason: 'answer' | 'aborted' = 'answer') {
  return { reason, answer: 'ok', durationMs, isAborted: reason === 'aborted', turnId }
}

// The button labels, which are no part of the reading.
const BUTTONS = new Set(['Stop', 'Start', 'Start again'])

// The band's words in order, the way a person reads the line.
async function line(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  const texts = await ui.findAll({ type: 'Text' })
  return texts
    .map(t => t.text)
    .filter(text => !BUTTONS.has(text))
    .join(' ')
}

const FRESH_LINE =
  'Been waiting 0s · Total waiting on you 0s · Claude thinking 0s · Total time 0s'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows the four counters in order, on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    engine(on, { id: `s-${surface}`, turns: 0, startedAt: T0 })

    await $.session.start(START)
    const quiet = await $.ui.mount({ ...BAND, surface })
    expect(await line(quiet)).toBe('Not started')
    expect(await quiet.find({ key: 'start' })).toBeDefined()
    await quiet.unmount()

    await $.prompt.submit(sent('hello'))
    await clock.advance(400)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await clock.advance(5_000)

    const working = await $.ui.mount({ ...BAND, surface })
    expect(await line(working)).toBe(
      'Been waiting 0s · Total waiting on you 0s · Claude thinking 5s · Total time 5s',
    )
    expect(await working.find({ key: 'stop' })).toBeUndefined()
    await working.unmount()

    await clock.advance(3_000)
    await $.turn.complete(finished('t1', 8_000))

    const done = await $.ui.mount({ ...BAND, surface })
    expect(await line(done)).toBe(
      'Been waiting 0s · Total waiting on you 0s · Claude thinking 8s · Total time 8s',
    )
    expect(await done.find({ key: 'stop' })).toBeDefined()
    await done.unmount()
  })
}

test('your send zeroes the wait and rolls it into the total', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))

  await clock.advance(192_000)
  await $.prompt.submit(sent('two'))
  await clock.advance(600)
  await $.turn.start({ text: 'two', turnId: 't2' })
  await clock.advance(4_000)

  const working = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(working)).toBe(
    'Been waiting 0s · Total waiting on you 3m · Claude thinking 12s · Total time 3m',
  )
  await working.unmount()

  await $.turn.complete(finished('t2', 4_600))
  const done = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(done)).toBe(
    'Been waiting 0s · Total waiting on you 3m · Claude thinking 12s · Total time 3m',
  )
})

test('Stop freezes the totals, and your next prompt picks them back up', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))
  await clock.advance(2 * MIN)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  const stopped = 'Stopped · Total waiting on you 2m · Claude thinking 8s · Total time 2m'
  expect(await line(ui)).toBe(stopped)
  expect(await ui.find({ key: 'stop' })).toBeUndefined()

  await clock.advance(60 * MIN)
  expect(await line(ui)).toBe(stopped)

  await $.prompt.submit(sent('back again'))
  await $.turn.start({ text: 'back again', turnId: 't2' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 2m · Claude thinking 8s · Total time 2m',
  )

  await clock.advance(5_000)
  await $.turn.complete(finished('t2', 5_000))
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 2m · Claude thinking 13s · Total time 2m',
  )
})

test('Stop turns into Start again, which picks the totals back up at once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))
  await clock.advance(MIN)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'start' })).toBeUndefined()
  await ui.press({ key: 'stop' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ key: 'start' })).toBeDefined()

  await clock.advance(10 * MIN)
  await ui.press({ key: 'start' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 1m · Claude thinking 8s · Total time 1m',
  )
  expect(await ui.find({ key: 'start' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  await clock.advance(90_000)
  expect(await line(ui)).toBe(
    'Been waiting 1m 30s · Total waiting on you 2m · Claude thinking 8s · Total time 2m',
  )

  await $.prompt.submit(sent('two'))
  await $.turn.start({ text: 'two', turnId: 't2' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 2m · Claude thinking 8s · Total time 2m',
  )
})

test('every stop is left out, however many there are', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(MIN)
  await ui.press({ key: 'stop' })
  await clock.advance(10 * MIN)
  await ui.press({ key: 'start' })
  await clock.advance(MIN)
  await ui.press({ key: 'stop' })
  expect(await line(ui)).toBe(
    'Stopped · Total waiting on you 2m · Claude thinking 8s · Total time 2m',
  )

  await clock.advance(5 * 60 * MIN)
  await ui.press({ key: 'start' })
  await $.prompt.submit(sent('two'))
  await $.turn.start({ text: 'two', turnId: 't2' })
  await clock.advance(20_000)
  await $.turn.complete(finished('t2', 20_000))
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 2m · Claude thinking 28s · Total time 2m',
  )
})

test('Start again is saved, so a resumed session still leaves the stop out', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))
  await clock.advance(MIN)
  await $.command.run(STOP)
  await clock.advance(10 * MIN)
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await before.press({ key: 'start' })
  await before.unmount()

  // The process picks the session up again: it ends, starts again, and the
  // meter reads the session's figures back from the store.
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await $.session.start(START)
  await clock.advance(30_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Been waiting 30s · Total waiting on you 1m · Claude thinking 8s · Total time 1m',
  )
})

test('Start begins the count in a session with none yet, and nothing runs before it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 5, startedAt: T0 - 60 * MIN })
  await $.session.start(START)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe('Not started')
  await clock.advance(10 * MIN)
  expect(await line(ui)).toBe('Not started')

  await ui.press({ key: 'start' })
  expect(await line(ui)).toBe(FRESH_LINE)
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  await clock.advance(2 * MIN)
  expect(await line(ui)).toBe(
    'Been waiting 2m 00s · Total waiting on you 2m · Claude thinking 0s · Total time 2m',
  )
})

test('/stop-meter stops it, and waits while Claude works', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  expect((await $.command.run(STOP)).text).toBe(
    'Claude is still working. Stop the meter once it finishes.',
  )

  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))
  await clock.advance(MIN)
  expect((await $.command.run(STOP)).text).toBe(
    'Session meter stopped. Start again or your next prompt picks it up where it left off.',
  )
  expect((await $.command.run(STOP)).text).toBe(
    'The session meter is already stopped.',
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Stopped · Total waiting on you 1m · Claude thinking 8s · Total time 1m',
  )
})

test('the away catch stops the count 30 minutes after Claude finished', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))

  await clock.advance(29 * MIN)
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(before)).toContain('Been waiting 29m')
  await before.unmount()

  await clock.advance(16 * MIN)
  const away = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(away)).toBe(
    'Away · Total waiting on you 30m · Claude thinking 8s · Total time 30m',
  )
  expect(await away.find({ key: 'stop' })).toBeUndefined()
  await away.unmount()

  await $.prompt.submit(sent('back'))
  await $.turn.start({ text: 'back', turnId: 't2' })
  const back = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(back)).toBe(
    'Been waiting 0s · Total waiting on you 30m · Claude thinking 8s · Total time 30m',
  )
})

test('a turn Claude starts on its own in a stopped count stays unmetered', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))
  await clock.advance(MIN)
  await $.command.run(STOP)

  await clock.advance(10 * MIN)
  await $.prompt.submit(sent('a task finished', { origin: 'task-notification' }))
  await $.turn.start({ text: 'a task finished', turnId: 't2' })
  await clock.advance(5_000)
  await $.turn.complete(finished('t2', 5_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Stopped · Total waiting on you 1m · Claude thinking 8s · Total time 1m',
  )

  await clock.advance(2 * MIN)
  await $.prompt.submit(sent('me again'))
  await $.turn.start({ text: 'me again', turnId: 't3' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 1m · Claude thinking 8s · Total time 1m',
  )
})

test('a command that starts no turn does not end the wait', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))

  await clock.advance(60_000)
  await $.prompt.submit(sent('/reload-plugins', { command: 'reload-plugins' }))
  await clock.advance(20_000)
  const still = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(still)).toContain('Been waiting 1m 20s · Total waiting on you 1m')
  await still.unmount()

  await clock.advance(10_000)
  await $.prompt.submit(sent('go'))
  await $.turn.start({ text: 'go', turnId: 't2' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 1m · Claude thinking 8s · Total time 1m',
  )
})

test('a send whose turn never starts leaves Claude waiting on you', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))

  await clock.advance(10_000)
  await $.prompt.submit(sent('dropped on the way'))
  const sentNow = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(sentNow)).toContain('Been waiting 0s · Total waiting on you 10s')
  await sentNow.unmount()

  await clock.advance(31_000)
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(later)).toContain('Been waiting 41s · Total waiting on you 41s')
})

test('a turn Claude starts on its own counts as its time, and the totals add up', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))

  await clock.advance(30_000)
  await $.prompt.submit(sent('a task finished', { origin: 'task-notification' }))
  await $.turn.start({ text: 'a task finished', turnId: 't2' })
  const notified = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(notified)).toBe(
    'Been waiting 0s · Total waiting on you 30s · Claude thinking 8s · Total time 38s',
  )
  await notified.unmount()

  await clock.advance(2_000)
  await $.turn.complete(finished('t2', 2_000))
  await clock.advance(10_000)
  await $.prompt.submit(sent('two'))
  await $.turn.start({ text: 'two', turnId: 't3' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 40s · Claude thinking 10s · Total time 50s',
  )
})

test('the totals shown add up to the count, minute for minute', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('one'))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await clock.advance(2_450_000) // Claude: 40m 50s
  await $.turn.complete(finished('t1', 2_450_000))
  await clock.advance(10 * MIN) // you: 10m
  await $.prompt.submit(sent('two'))
  await $.turn.start({ text: 'two', turnId: 't2' })
  await $.turn.complete(finished('t2', 0))
  await clock.advance(1_575_000) // you: 26m 15s, so 77m 05s since the first prompt

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Been waiting 26m · Total waiting on you 37m · Claude thinking 40m · Total time 1h 17m',
  )
})

test('a follow-up turn a Stop hook forces stays Claude time', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('go'))
  await clock.advance(400)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(8_000)
  await $.turn.complete(finished('t1', 8_000))
  await clock.advance(500)
  await $.turn.start({ text: '', turnId: 't2' })
  await clock.advance(2_000)
  await $.turn.complete(finished('t2', 2_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 0s · Claude thinking 10s · Total time 10s',
  )
})

test('a prompt typed over a running turn does not restart its clock', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('first'))
  await $.turn.start({ text: 'first', turnId: 't1' })
  await clock.advance(5_000)
  await $.prompt.submit(sent('also this', { turnId: 't1' }))
  await clock.advance(5_000)
  await $.turn.complete(finished('t1', 10_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toContain('Claude thinking 10s')
})

test('a stopped turn still counts as Claude time', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('go'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(3_000)
  await $.turn.complete(finished('t1', 3_000, 'aborted'))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toContain('Claude thinking 3s')
})

test('a session the meter joins midway shows Not started until your next prompt', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 3, startedAt: T0 - 90 * 24 * 60 * MIN })
  await $.session.start(START)
  await clock.advance(1) // the meter opens the session on a timer, off the hook

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe('Not started')

  await $.prompt.submit(sent('hello again'))
  await $.turn.start({ text: 'hello again', turnId: 't1' })
  expect(await line(ui)).toBe(FRESH_LINE)
})

const RESUMED = {
  firstPromptAt: T0 - 3_600_000,
  isFirstPromptEstimate: false,
  lastEndedAt: T0 - 60_000,
  lastMs: 134_000,
  lastEnd: 'answer',
  workMs: 1_200_000,
  stretches: 9,
}
const RESUMED_LINE =
  'Been waiting 1m 00s · Total waiting on you 40m · Claude thinking 20m · Total time 1h 00m'

test('a resumed session picks up its saved count', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { 's:s1': RESUMED })
  engine(on, { id: 's1', turns: 12, startedAt: T0 - 3_600_000 })
  await $.session.start(START)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(RESUMED_LINE)
})

test('a record from an earlier version still loads, its own wait figures set aside', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {
    's:s1': { ...RESUMED, gapMs: 30_000, gapTotalMs: 330_000, gaps: 1, idleTotalMs: 330_000 },
  })
  engine(on, { id: 's1', turns: 12, startedAt: T0 - 3_600_000 })
  await $.session.start(START)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(RESUMED_LINE)
})

test('a session resumed after a long time away opens stopped', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { 's:s1': { ...RESUMED, lastEndedAt: T0 - 3 * 24 * 60 * MIN } })
  engine(on, { id: 's1', turns: 12, startedAt: T0 - 4 * 24 * 60 * MIN })
  await $.session.start(START)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toMatch(/^Away · /)
})

test('a stop saved by an earlier version picks back up where it left off', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { 's:s1': { ...RESUMED, stoppedAt: T0 - 30_000, stoppedBy: 'you' } })
  engine(on, { id: 's1', turns: 12, startedAt: T0 - 3_600_000 })
  await $.session.start(START)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const stopped = 'Stopped · Total waiting on you 39m · Claude thinking 20m · Total time 59m'
  expect(await line(ui)).toBe(stopped)

  await clock.advance(3 * 24 * 60 * MIN)
  expect(await line(ui)).toBe(stopped)
  await ui.press({ key: 'start' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 39m · Claude thinking 20m · Total time 59m',
  )
})

test('a /clear starts the meter over', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const session = { id: 's1', turns: 0, startedAt: T0 }
  engine(on, session)
  await $.session.start(START)

  await $.prompt.submit(sent('go'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(3_000)
  await $.turn.complete(finished('t1', 3_000))

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  session.id = 's2'
  const cleared = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(cleared)).toBe('Not started')
  await cleared.unmount()

  await clock.advance(60_000)
  await $.prompt.submit(sent('fresh start'))
  await $.turn.start({ text: 'fresh start', turnId: 't2' })
  await clock.advance(2_000)
  await $.turn.complete(finished('t2', 2_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 0s · Claude thinking 2s · Total time 2s',
  )
})

test('a narrow band still shows all four', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('go'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(4_000)
  await $.turn.complete(finished('t1', 4_000))

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, bodyColumns: 60 },
  })
  expect(await line(ui)).toBe(
    'Been waiting 0s · Total waiting on you 0s · Claude thinking 4s · Total time 4s',
  )
})

test('the wait counts by the second, then by the minute after three', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('go'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(4_000)
  await $.turn.complete(finished('t1', 4_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toContain('Been waiting 0s')
  await clock.advance(2_000)
  expect(await line(ui)).toContain('Been waiting 2s · Total waiting on you 2s')
  await clock.advance(4 * MIN)
  expect(await line(ui)).toContain('Been waiting 4m · Total waiting on you 4m')
})

test('a notification starts no count, but its work is Claude time', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on, { id: 's1', turns: 0, startedAt: T0 })
  await $.session.start(START)

  await $.prompt.submit(sent('a task finished', { origin: 'task-notification' }))
  await $.turn.start({ text: 'a task finished', turnId: 't1' })
  await clock.advance(6_000)
  await $.turn.complete(finished('t1', 6_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(ui)).toBe('Been waiting 0s · Total waiting on you 0s · Claude thinking 6s')
  await ui.unmount()

  await clock.advance(60_000)
  await $.prompt.submit(sent('from my phone', { origin: 'bridge' }))
  await $.turn.start({ text: 'from my phone', turnId: 't2' })
  const phone = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await line(phone)).toBe(
    'Been waiting 0s · Total waiting on you 0s · Claude thinking 6s · Total time 0s',
  )
})
