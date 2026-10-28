CREATE INDEX "notification_rules_local_due" ON "notification_rules" USING btree (("value"->>'next_at'),"id") WHERE "notification_rules"."value"->>'scheduler_key' = 'zero-local-v1'
        AND "notification_rules"."value"->>'status' = 'active'
        AND "notification_rules"."value"->>'scheduler_state' = 'installed'
        AND "notification_rules"."value"->>'kind' IN ('reminder', 'timer')
        AND "notification_rules"."value"->>'wake_date' IS NULL
        AND "notification_rules"."value"->'condition' = 'null'::jsonb;