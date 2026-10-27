PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text,
	`definition` text NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_model_connections`("id", "host_id", "definition") SELECT "id", "host_id", "definition" FROM `model_connections`;--> statement-breakpoint
DROP TABLE `model_connections`;--> statement-breakpoint
ALTER TABLE `__new_model_connections` RENAME TO `model_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;