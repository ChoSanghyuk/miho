CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `roles_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `role` text;