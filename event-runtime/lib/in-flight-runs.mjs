/**
 * Runs for an agent that are still in flight, oldest first. PROPOSED remains
 * excluded (OPS-436): an unapproved watched proposal must not silence later
 * schedule slots. Returning the rows lets singleton NOOPs identify the run
 * they deferred to instead of dropping that audit evidence.
 */
export function inFlightRunsForAgent(db, agentRef) {
  return db
    .query(
      `SELECT run_id, state, created_at FROM runs
       WHERE state NOT IN ('PROPOSED','COMPLETED','REFUSED','FAILED','TIMED_OUT','CANCELLED')
         AND json_extract(spec_json, '$.agent') = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(agentRef);
}
