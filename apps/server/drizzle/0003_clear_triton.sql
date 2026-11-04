CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`parallel` integer NOT NULL,
	`status` text NOT NULL,
	`group_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
