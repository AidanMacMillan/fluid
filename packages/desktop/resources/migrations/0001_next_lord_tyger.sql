CREATE TABLE "history_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"tab_id" uuid,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"session_id" text,
	"extension_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "history_entries" ADD CONSTRAINT "history_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "history_entries_task_time_idx" ON "history_entries" USING btree ("task_id","visited_at","id");