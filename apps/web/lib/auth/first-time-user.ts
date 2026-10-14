/**
 * Utilities for detecting and handling first-time user welcome flow.
 *
 * A first-time user is one whose account was created very recently
 * (within the last 5 minutes) and is now viewing the Radar for the first time.
 * We show a welcome banner on first visit.
 */

/** Window for considering an account "just created" (in milliseconds) */
const JUST_CREATED_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Check if a user account was created very recently.
 *
 * Used to determine if a welcome banner should be shown on the Radar.
 * A user is considered "just created" if their account was created
 * within the last 5 minutes.
 *
 * @param createdAt - User's account creation timestamp
 * @returns true if the account was created recently
 */
export function isJustCreated(createdAt: Date | string): boolean {
  const created = typeof createdAt === 'string' ? new Date(createdAt) : createdAt
  const now = new Date()
  const ageMs = now.getTime() - created.getTime()
  return ageMs < JUST_CREATED_WINDOW_MS && ageMs >= 0
}
