ALTER TABLE "access_profiles" ADD COLUMN "approved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "access_profiles" SET "approved" = true WHERE "enabled" = true;
