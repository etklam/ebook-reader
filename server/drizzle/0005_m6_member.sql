-- M6 member policy: canonical usernames (unique, case-folded by callers).
CREATE UNIQUE INDEX "users_username_uq" ON "app"."users" USING btree ("username");
