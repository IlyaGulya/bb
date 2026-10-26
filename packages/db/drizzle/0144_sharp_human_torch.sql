CREATE TABLE `execution_context_projects` (
	`execution_context_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`execution_context_id`, `project_id`),
	FOREIGN KEY (`execution_context_id`) REFERENCES `execution_contexts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `execution_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`default_model_connection_id` text,
	`definition` text NOT NULL,
	FOREIGN KEY (`default_model_connection_id`) REFERENCES `model_connections`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `model_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`definition` text NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `project_context_defaults` (
	`project_id` text PRIMARY KEY NOT NULL,
	`execution_context_id` text,
	`model_connection_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_context_id`) REFERENCES `execution_contexts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`model_connection_id`) REFERENCES `model_connections`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `thread_execution_bindings` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
