-- Drop the heartbeat-run gate from the routine dedup index.
-- The old index required execution_run_id IS NOT NULL, which meant an open
-- routine-execution issue with no live heartbeat was invisible to dedup and
-- triggered spurious duplicate issues (AKS-1628 / AKS-1613).
--> statement-breakpoint
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "issues"."origin_kind" = 'routine_execution'
    AND "issues"."origin_id" IS NOT NULL
    AND "issues"."hidden_at" IS NULL
    AND "issues"."status" IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
