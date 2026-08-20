-- R-51：四个 agent 角色合并成一个 'deck'。见 docs/12-single-agent.md 阶段 C。
--
-- 保 generator 那一行、删掉其余三行的理由：四个角色里只有 generator 拿全部工具，
-- 它的模型配置最接近合并后的 agent 需要的。planner / reviewer 配的往往是便宜模型
-- （只读、只出判断），拿它当唯一 agent 的默认会让生成质量掉。
--
-- 顺序要紧：先删后改。反过来的话，role_defaults.role 上的 UNIQUE 约束
-- 会在「库里已经存在一行 deck」时被撞上，整条迁移回滚。先删干净再改，
-- 任何历史状态下都只剩至多一行。
--
-- 写这个文件踩到的两个坑，都是实测撞出来的：
--   1. drizzle 按分隔标记切开逐段执行，**纯注释的一段会直接抛错**
--      （"Query contained no valid SQL statement"）。每段注释必须和它下面那条语句待在一起。
--   2. **注释里不能出现那个分隔标记的字面量。** 切分是纯文本 split，
--      不认注释 —— 在注释里提它一次，文件就会从注释中间被劈开。
DELETE FROM `role_defaults` WHERE `role` IN ('planner', 'reviewer', 'editor');
--> statement-breakpoint
UPDATE `role_defaults` SET `role` = 'deck' WHERE `role` = 'generator';
--> statement-breakpoint
DELETE FROM `user_role_preferences` WHERE `role` IN ('planner', 'reviewer', 'editor');
--> statement-breakpoint
UPDATE `user_role_preferences` SET `role` = 'deck' WHERE `role` = 'generator';
