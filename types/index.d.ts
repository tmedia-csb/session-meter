/** How a stretch of work ended: turn.complete's own reason. */
export type MeterEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** Who stopped the count: the person (the Stop button or /stop-meter), or the away catch. */
export type MeterStop = 'you' | 'away'

/**
 * One session's count. It runs from the person's first send that starts a
 * turn (or Start) until they stop the meter, or until Claude has waited on
 * them for the away cutoff; Start again or their next send picks it back up
 * where it left off, and the time it spent stopped counts nowhere. A stretch
 * is Claude working: from the send that starts it (or the moment a turn starts
 * on its own) to the end of the turn, a follow-up turn a Stop hook forces
 * included. Every other counted moment is Claude waiting on the person, so
 * the wait in all is the count's time less the stretches.
 */
export type Meter = {
  /** The session these figures belong to; null until first read. */
  sessionId: string | null
  /** When the count's first send (or Start) went in, in ms since the epoch. */
  firstPromptAt: number | null
  /** True when firstPromptAt is a session's launch rather than a send (records from before 261117 evening). */
  isFirstPromptEstimate: boolean
  /** When a send made while Claude was idle went in, until its turn starts. */
  pendingAt: number | null
  /** True when that send is the person's own, not a notification's. */
  isPendingPersons: boolean
  /** True when that send was a slash command, which may start no turn: Claude still waits on the person. */
  isPendingCommand: boolean
  /** When the stretch under way began; null while Claude is idle. */
  runningSince: number | null
  /** When the last finished stretch ended. */
  lastEndedAt: number | null
  /** How long the last finished stretch took, in ms. */
  lastMs: number | null
  /** How the last finished stretch ended. */
  lastEnd: MeterEnd | null
  /** Every finished stretch of the count added together, in ms. */
  workMs: number
  /** How many stretches of the count have finished. */
  stretches: number
  /** When the count stopped; null while it runs. */
  stoppedAt: number | null
  /** Who stopped it. */
  stoppedBy: MeterStop | null
  /** Time the count has spent stopped since its first send, in ms: left out of every total. */
  pausedMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { meter: Shaped<Meter>; beat: number }
  }
}
