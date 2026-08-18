ALTER TABLE `conversations` ADD `title` text DEFAULT '新会话' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `forked_from_id` integer;--> statement-breakpoint
--
-- updated_at 必须带常量默认值：SQLite 的 ALTER TABLE ADD COLUMN
-- 既不接受 NOT NULL 无默认（已有行会变 NULL），也不接受 unixepoch() 这类非常量默认。
-- 先用 0 占位，下一句回填成 created_at。
--
ALTER TABLE `conversations` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `conversations` SET `updated_at` = `created_at` WHERE `updated_at` = 0;--> statement-breakpoint
--
-- 已有会话回填标题：取该会话首条用户消息的前 20 字，
-- 否则一升级全都叫「新会话」，列表没法用。
--
UPDATE `conversations` SET `title` = COALESCE((
  SELECT substr(m.content, 1, 20)
  FROM messages m
  WHERE m.conversation_id = `conversations`.`id` AND m.role = 'user'
  ORDER BY m.id
  LIMIT 1
), '新会话');
