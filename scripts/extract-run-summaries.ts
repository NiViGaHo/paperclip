#!/usr/bin/env npx tsx

/**
 * Populates input_summary, output_summary, and decision_memo on heartbeat_runs
 * for newly completed runs that are missing these fields.
 *
 * Intended to run daily as a Paperclip routine (AKS-2142).
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const BATCH_SIZE = 200;
const INPUT_SUMMARY_MAX = 500;
const OUTPUT_SUMMARY_MAX = 4_096;
const DECISION_MEMO_MAX = 500;

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

interface RunRow {
  id: string;
  invocation_source: string;
  trigger_detail: string | null;
  result_json: Record<string, unknown> | null;
  stdout_excerpt: string | null;
  context_snapshot: Record<string, unknown> | null;
}

function truncate(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function extractTextFromJson(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function buildInputSummary(run: RunRow): string | null {
  const fromTrigger = truncate(run.trigger_detail, INPUT_SUMMARY_MAX);
  if (fromTrigger) return fromTrigger;

  const wakeReason = truncate(
    (run.context_snapshot as { wakeReason?: unknown } | null)?.wakeReason,
    INPUT_SUMMARY_MAX,
  );
  if (wakeReason) return wakeReason;

  return truncate(run.invocation_source, INPUT_SUMMARY_MAX);
}

function buildOutputSummary(run: RunRow): string | null {
  const fromResultJson = extractTextFromJson(run.result_json, ["summary", "result", "message"]);
  if (fromResultJson) return truncate(fromResultJson, OUTPUT_SUMMARY_MAX);
  return truncate(run.stdout_excerpt, OUTPUT_SUMMARY_MAX);
}

function buildDecisionMemo(run: RunRow): string | null {
  return truncate(
    extractTextFromJson(run.result_json, ["summary", "result"]),
    DECISION_MEMO_MAX,
  );
}

async function main() {
  const sql = postgres(DATABASE_URL!, { max: 2 });

  try {
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs'
        AND column_name IN ('input_summary', 'output_summary', 'decision_memo')
    `;

    if (columns.length < 3) {
      console.error(
        `Summary columns missing from heartbeat_runs (found ${columns.length}/3). ` +
          "Apply migration 0067_run_summary_fields.sql before running this script.",
      );
      process.exit(1);
    }

    let totalProcessed = 0;
    let totalUpdated = 0;

    while (true) {
      // Always fetch with OFFSET 0 — updated rows drop out of the WHERE clause,
      // so the window naturally advances without needing an explicit offset.
      const runs = await sql<RunRow[]>`
        SELECT id, invocation_source, trigger_detail, result_json,
               stdout_excerpt, context_snapshot
        FROM heartbeat_runs
        WHERE status NOT IN ('queued', 'running')
          AND (input_summary IS NULL OR output_summary IS NULL OR decision_memo IS NULL)
        ORDER BY finished_at DESC NULLS LAST
        LIMIT ${BATCH_SIZE}
      `;

      if (runs.length === 0) break;

      for (const run of runs) {
        // Use empty string as sentinel when no content can be derived; this ensures
        // rows exit the NULL-check pool even when all three derived values are empty.
        const inputSummary = buildInputSummary(run) ?? "";
        const outputSummary = buildOutputSummary(run) ?? "";
        const decisionMemo = buildDecisionMemo(run) ?? "";

        await sql`
          UPDATE heartbeat_runs
          SET
            input_summary  = COALESCE(input_summary,  ${inputSummary}),
            output_summary = COALESCE(output_summary, ${outputSummary}),
            decision_memo  = COALESCE(decision_memo,  ${decisionMemo})
          WHERE id = ${run.id}
        `;

        totalUpdated++;
      }

      totalProcessed += runs.length;
      process.stdout.write(`\rProcessed ${totalProcessed} runs (${totalUpdated} updated)...`);
    }

    process.stdout.write("\n");

    const remaining = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM heartbeat_runs
      WHERE status = ANY(${TERMINAL_STATUSES as unknown as string[]})
        AND (input_summary IS NULL OR output_summary IS NULL OR decision_memo IS NULL)
    `;

    console.log(
      `Done. Processed ${totalProcessed} runs, updated ${totalUpdated}. ` +
        `Remaining unsummarized: ${remaining[0]?.count ?? "unknown"}.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
