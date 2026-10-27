CREATE TABLE "group_members" (
	"bot" text NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"observed" boolean DEFAULT false NOT NULL,
	"location_entity" text DEFAULT '' NOT NULL,
	"geocoded_location_entity" text DEFAULT '' NOT NULL,
	CONSTRAINT "group_members_pkey" PRIMARY KEY("bot","chat_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_profile_fkey" FOREIGN KEY ("bot","chat_id") REFERENCES "access_profiles"("bot","chat_id") ON DELETE cascade ON UPDATE no action;