#!/usr/bin/env node

/**
 * Finds routine execution issues that have been `blocked` for >30 min
 * with no live heartbeat run, and cancels them.
 *
 * This unblocks the routine's `skip_if_active` concurrency policy so it
 * can re-fire on the next schedule cycle.
 *
 * Intended to run every 15 min as a Paperclip routine (AKS-2169).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/cancel-zombie-routine-executions.js
 *   DATABASE_URL=postgres://... node scripts/cancel-zombie-routine-executions.js --dry-run
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const ZOMBIE_THRESHOLD_MINUTES = 30;
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const sql = postgres(DATABASE_URL, { max: 2 });

  try {
    const threshold = new Date(Date.now() - ZOMBIE_THRESHOLD_MINUTES * 60_000);

    // An issue is a zombie when it is:
    //   - a routine execution issue (origin_kind = 'routine_execution')
    //   - stuck in `blocked` status (not hidden, not terminal)
    //   - hasn't been updated in >30 min
    //   - no live heartbeat run is currently processing it
    const zombies = await sql`
      SELECT
        i.id,
        i.identifier,
        i.title,
        i.origin_id,
        i.updated_at,
        i.execution_run_id,
        hr.status AS run_status
      FROM issues i
      LEFT JOIN heartbeat_runs hr ON hr.id = i.execution_run_id
      WHERE i.origin_kind = 'routine_execution'
        AND i.status = 'blocked'
        AND i.hidden_at IS NULL
        AND i.updated_at < ${threshold}
        AND (
          i.execution_run_id IS NULL
          OR hr.status NOT IN ('queued', 'running')
        )
      ORDER BY i.updated_at ASC
    `;

    if (zombies.length === 0) {
      console.log("No zombie routine execution issues found.");
      return;
    }

    console.log(`Found ${zombies.length} zombie routine execution issue(s).`);

    for (const zombie of zombies) {
      const blockedMinutes = Math.round(
        (Date.now() - new Date(zombie.updated_at).getTime()) / 60_000,
      );
      const runInfo = zombie.execution_run_id
        ? ` (run ${zombie.execution_run_id} status: ${zombie.run_status})`
        : " (no execution run)";
      console.log(
        `  ${zombie.identifier ?? zombie.id} — "${zombie.title}" blocked ~${blockedMinutes} min${runInfo}`,
      );

      if (!DRY_RUN) {
        await sql`
          UPDATE issues
          SET
            status       = 'cancelled',
            cancelled_at = NOW(),
            updated_at   = NOW()
          WHERE id = ${zombie.id}
        `;
      }
    }

    if (DRY_RUN) {
      console.log(`Dry-run mode — no issues were cancelled.`);
    } else {
      console.log(`Cancelled ${zombies.length} zombie issue(s).`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
