DROP INDEX "candidates_office_position_unique";--> statement-breakpoint
DROP INDEX "candidates_election_office_idx";--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN "office";--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_election_position_unique" ON "candidates" ("election_id","ballot_position");