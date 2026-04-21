ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "precondition_query" text;
--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "precondition_endpoint" text;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "skip_reason" text;
