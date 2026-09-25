CREATE TYPE "public"."task_status" AS ENUM('open', 'settled');--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"icon" text,
	"keywords" jsonb,
	"group" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clipboard_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"html" text,
	"rtf" text,
	"safe_html" text,
	"storage_key" text,
	"thumbnail" text,
	"width" integer,
	"height" integer,
	"size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clipboard_entries_kind_check" CHECK ("kind" in ('text', 'rich-text', 'image', 'files'))
);
--> statement-breakpoint
CREATE TABLE "extension_storage" (
	"extension_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_storage_extension_id_key_pk" PRIMARY KEY("extension_id","key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"root" text,
	"space_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_icons" (
	"origin" text PRIMARY KEY NOT NULL,
	"data_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tab_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"folder_id" uuid,
	"type" text NOT NULL,
	"title" text,
	"position" integer NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_url" text,
	"profile" integer,
	"activity" text,
	"payload" jsonb NOT NULL,
	"view_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tabs_type_check" CHECK ("type" in ('browser', 'file') or "type" ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
	CONSTRAINT "tabs_pinned_url_check" CHECK ("pinned_url" is null or "type" = 'browser' or "type" ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
	CONSTRAINT "tabs_activity_check" CHECK ("activity" is null or "activity" in ('working', 'waiting', 'done')),
	CONSTRAINT "tabs_profile_check" CHECK ("profile" is null or ("type" = 'browser' and "profile" in (1, 2, 3, 4, 5, 6)))
);
--> statement-breakpoint
CREATE TABLE "task_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text,
	"type" text,
	"icon" text DEFAULT 'circle-dashed' NOT NULL,
	"color" text DEFAULT 'grey' NOT NULL,
	"facts" jsonb,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"active_tab_id" uuid,
	"splits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_type_check" CHECK ("type" is null or "type" ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
	CONSTRAINT "tasks_color_check" CHECK ("color" in ('grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'))
);
--> statement-breakpoint
ALTER TABLE "clipboard_entries" ADD CONSTRAINT "clipboard_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tab_folders" ADD CONSTRAINT "tab_folders_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tab_folders" ADD CONSTRAINT "tab_folders_parent_id_tab_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tab_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_folder_id_tab_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."tab_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_active_tab_id_tabs_id_fk" FOREIGN KEY ("active_tab_id") REFERENCES "public"."tabs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookmarks_position_idx" ON "bookmarks" USING btree ("position");--> statement-breakpoint
CREATE INDEX "clipboard_entries_task_id_created_at_idx" ON "clipboard_entries" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_position_idx" ON "projects" USING btree ("position");--> statement-breakpoint
CREATE INDEX "projects_space_id_idx" ON "projects" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "spaces_position_idx" ON "spaces" USING btree ("position");--> statement-breakpoint
CREATE INDEX "tab_folders_task_id_idx" ON "tab_folders" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tabs_task_id_position_idx" ON "tabs" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX "task_notes_task_id_created_at_idx" ON "task_notes" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_project_id_status_position_idx" ON "tasks" USING btree ("project_id","status","position");--> statement-breakpoint
-- The space a new install starts in, at the fixed id `partitionFor` recognises
-- (see DEFAULT_SPACE_ID in src/main/browsing.ts), and its first project. The
-- default space cannot be deleted, and `deleteProject` refuses the last project,
-- so there is always one of each.
INSERT INTO "spaces" ("id", "name", "position")
VALUES ('00000000-0000-0000-0000-000000000000', 'Default', 0);--> statement-breakpoint
INSERT INTO "projects" ("name", "root", "position", "space_id")
VALUES ('Default', NULL, 0, '00000000-0000-0000-0000-000000000000');
