CREATE TABLE `asset_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`search_provider` text DEFAULT 'wikimedia' NOT NULL,
	`search_api_key` text DEFAULT '' NOT NULL,
	`search_enabled` integer DEFAULT false NOT NULL,
	`image_model_config_id` integer,
	`generate_enabled` integer DEFAULT false NOT NULL,
	`max_edge_px` integer DEFAULT 1600 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`image_model_config_id`) REFERENCES `model_configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `storage_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text DEFAULT 'cos' NOT NULL,
	`secret_id` text DEFAULT '' NOT NULL,
	`secret_key` text DEFAULT '' NOT NULL,
	`bucket` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`prefix` text DEFAULT 'rabbit/' NOT NULL,
	`public_base_url` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `model_configs` ADD `rate_limit_per_min` integer;