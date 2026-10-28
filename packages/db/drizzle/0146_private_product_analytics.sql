CREATE TABLE `product_analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`operation_id` text NOT NULL,
	`feature_id` text NOT NULL,
	`action` text NOT NULL,
	`version` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_session_id` text,
	`surface` text NOT NULL,
	`mode` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text NOT NULL,
	`timestamp` integer NOT NULL,
	`duration_ms` integer,
	`release` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`projected_at` integer
);
--> statement-breakpoint
CREATE INDEX `product_analytics_scope_mode_time` ON `product_analytics_events` (`scope`,`mode`,`timestamp`);--> statement-breakpoint
CREATE INDEX `product_analytics_projection` ON `product_analytics_events` (`projected_at`,`admitted_at`);--> statement-breakpoint
CREATE TABLE `product_analytics_health` (
	`scope_mode` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`gaps` integer DEFAULT 0 NOT NULL,
	`expired` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`last_accepted_at` integer,
	`last_projected_at` integer
);
