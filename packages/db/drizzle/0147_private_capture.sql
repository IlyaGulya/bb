CREATE TABLE `private_capture_artifacts` (
	`capture_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`manifest` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`rejected_at` integer,
	`purged_at` integer,
	PRIMARY KEY(`capture_id`, `artifact_id`)
);
--> statement-breakpoint
CREATE TABLE `private_capture_chunks` (
	`capture_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`receipt_id` text NOT NULL,
	`committed_at` integer NOT NULL,
	PRIMARY KEY(`capture_id`, `artifact_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `private_capture_links` (
	`capture_id` text NOT NULL,
	`link_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`capture_id`, `link_id`)
);
--> statement-breakpoint
CREATE INDEX `private_capture_link_thread_idx` ON `private_capture_links` (`thread_id`,`capture_id`);--> statement-breakpoint
CREATE TABLE `private_capture_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`execution_context_id` text NOT NULL,
	`thread_id` text,
	`host_id` text NOT NULL,
	`session` text NOT NULL,
	`enabled` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_sync_at` integer,
	`last_ack_at` integer,
	`next_sync_at` integer NOT NULL,
	`gap` text DEFAULT 'none' NOT NULL,
	`gap_count` integer DEFAULT 0 NOT NULL,
	`event_cursor` integer DEFAULT 0 NOT NULL,
	`cpa_stamps` text DEFAULT '{}' NOT NULL,
	`host_status` text,
	`host_enabled` integer
);
--> statement-breakpoint
CREATE INDEX `private_capture_scope_idx` ON `private_capture_sessions` (`project_id`,`execution_context_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `private_capture_due_idx` ON `private_capture_sessions` (`enabled`,`next_sync_at`);--> statement-breakpoint
CREATE INDEX `private_capture_expiry_idx` ON `private_capture_sessions` (`expires_at`);