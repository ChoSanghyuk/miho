CREATE TABLE `guidelines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `roles` ADD `guideline_ids_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `roles` ADD `description_index` integer DEFAULT 0 NOT NULL;