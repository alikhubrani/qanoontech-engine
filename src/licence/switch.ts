/**
 * Licensing is switched off.
 *
 * Nothing here is deleted and nothing is weakened: signing, verification,
 * heartbeats, grace, the status the panel shows and the `licence install`
 * command all work exactly as before. What is suspended is the one thing that
 * acts on the verdict — stopping a firm's deployment.
 *
 * Turning it back on is this one line. That is the whole reason it is a
 * constant in a file of its own rather than an environment variable: a flag
 * that decides whether a firm's system keeps running should not be settable by
 * a stray line in a compose file, and it should be visible in a diff when it
 * changes.
 *
 * Two things follow from it, both in `server/licence-tick.ts`:
 *
 *   - enforcement never runs, so a lapsed licence stops nothing;
 *   - a deployment that was *already* stopped by enforcement is started again,
 *     because a switch that only prevents new harm would leave whoever is
 *     already stopped stopped forever.
 *
 * And in `preflight/index.ts` the licence check reports a warning rather than a
 * failure, so a box with no licence can be deployed to. It stays a warning and
 * not a pass, because "no licence" is still true and a check that lies about it
 * is worse than one that blocks.
 */
export const LICENCE_ENFORCED = false

/** Shown wherever the disabled state needs explaining to a person. */
export const LICENCE_DISABLED_NOTE =
  'Licensing is switched off in this build; a licence is not required to deploy or run.'
