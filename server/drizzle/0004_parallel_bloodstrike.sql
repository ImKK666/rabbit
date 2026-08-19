CREATE TABLE `asset_search_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`query` text NOT NULL,
	`candidates_json` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` integer NOT NULL,
	`deck_id` integer,
	`prompt` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`hash` text,
	`storage_key` text,
	`width` integer,
	`height` integer,
	`bytes` integer,
	`original_bytes` integer,
	`compress_reason` text,
	`attribution_author` text,
	`attribution_source` text,
	`attribution_url` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_ticket_unique` ON `assets` (`ticket`);