-- @info - Community ratings: one 1-5 star rating per user per community
CREATE TABLE "community_ratings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"community_id" integer NOT NULL REFERENCES "communities"("id") ON DELETE CASCADE,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"rating" integer NOT NULL CHECK ("rating" BETWEEN 1 AND 5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_community_rating" ON "community_ratings" ("community_id", "user_id");--> statement-breakpoint
CREATE INDEX "idx_community_ratings_community" ON "community_ratings" ("community_id");
