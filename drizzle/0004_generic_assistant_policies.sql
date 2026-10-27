ALTER TABLE "assistant_definitions" DROP CONSTRAINT IF EXISTS "assistant_definitions_preset_check";
--> statement-breakpoint
ALTER TABLE "access_profiles" DROP CONSTRAINT IF EXISTS "access_profiles_prompt_preset_check";
--> statement-breakpoint
UPDATE "assistant_definitions" SET "preset" = CASE WHEN "preset" IN ('standard', 'automatic') THEN 'automatic' ELSE 'explicit' END, "builtin" = ("id" = 'zero');
--> statement-breakpoint
UPDATE "access_profiles" SET "prompt_preset" = CASE WHEN "prompt_preset" IN ('standard', 'automatic') THEN 'automatic' ELSE 'explicit' END WHERE "prompt_preset" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "assistant_definitions" ADD CONSTRAINT "assistant_definitions_preset_check" CHECK ("preset" IN ('automatic', 'explicit'));
--> statement-breakpoint
ALTER TABLE "access_profiles" ADD CONSTRAINT "access_profiles_prompt_preset_check" CHECK ("prompt_preset" IN ('automatic', 'explicit'));
