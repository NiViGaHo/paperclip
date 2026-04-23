ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "input_summary" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "output_summary" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "decision_memo" text;
