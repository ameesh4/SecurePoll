CREATE TYPE "admin_role" AS ENUM('REVIEWER', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "election_status" AS ENUM('DRAFT', 'REGISTRATION_OPEN', 'RINGS_FROZEN', 'VOTING_OPEN', 'VOTING_CLOSED', 'TALLIED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "email_delivery_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'BOUNCED');--> statement-breakpoint
CREATE TYPE "registration_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "admin_role" DEFAULT 'REVIEWER'::"admin_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"admin_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"election_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"title" text NOT NULL,
	"description" text,
	"status" "election_status" DEFAULT 'DRAFT'::"election_status" NOT NULL,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"voting_opens_at" timestamp with time zone,
	"voting_closes_at" timestamp with time zone,
	"ring_size" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "elections_ring_size_min" CHECK ("ring_size" >= 2),
	CONSTRAINT "elections_voting_window_valid" CHECK ("voting_opens_at" is null or "voting_closes_at" is null or "voting_closes_at" > "voting_opens_at")
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"election_id" uuid NOT NULL,
	"office" text NOT NULL,
	"name" text NOT NULL,
	"affiliation" text,
	"photo_url" text,
	"ballot_position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_ballot_position_positive" CHECK ("ballot_position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "voters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"full_name" text NOT NULL,
	"national_id" text NOT NULL,
	"email" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"full_name" text NOT NULL,
	"national_id" text NOT NULL,
	"email" text NOT NULL,
	"public_key" text NOT NULL,
	"status" "registration_status" DEFAULT 'PENDING'::"registration_status" NOT NULL,
	"rejection_reason" text,
	"reviewed_at" timestamp with time zone,
	"voter_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registrations_rejection_reason_required" CHECK ("status" <> 'REJECTED' or "rejection_reason" is not null),
	CONSTRAINT "registrations_voter_link_matches_status" CHECK (("status" = 'APPROVED') = ("voter_id" is not null)),
	CONSTRAINT "registrations_reviewed_at_matches_status" CHECK (("status" = 'PENDING') = ("reviewed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "election_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"election_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ring_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"ring_id" uuid NOT NULL,
	"election_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"position_in_ring" integer NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ring_members_position_non_negative" CHECK ("position_in_ring" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"election_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"published_at" timestamp with time zone,
	"chain_tx_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rings_index_non_negative" CHECK ("index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ballot_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"election_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"email_status" "email_delivery_status" DEFAULT 'PENDING'::"email_delivery_status" NOT NULL,
	"deliver_to" text NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"resend_window_started_at" timestamp with time zone,
	"resends_in_window" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ballot_access_tokens_expiry_after_issue" CHECK ("expires_at" > "issued_at"),
	CONSTRAINT "ballot_access_tokens_attempts_non_negative" CHECK ("delivery_attempts" >= 0 and "resends_in_window" >= 0),
	CONSTRAINT "ballot_access_tokens_redeemed_after_issue" CHECK ("redeemed_at" is null or "redeemed_at" >= "issued_at"),
	CONSTRAINT "ballot_access_tokens_status_needs_attempt" CHECK ("email_status" = 'PENDING' or "delivery_attempts" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admins_email_unique" ON "admins" ("email");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_admin_idx" ON "audit_log" ("admin_id");--> statement-breakpoint
CREATE INDEX "audit_log_election_created_idx" ON "audit_log" ("election_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_office_position_unique" ON "candidates" ("election_id","office","ballot_position");--> statement-breakpoint
CREATE INDEX "candidates_election_office_idx" ON "candidates" ("election_id","office");--> statement-breakpoint
CREATE UNIQUE INDEX "voters_national_id_unique" ON "voters" ("national_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voters_email_unique" ON "voters" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "voters_public_key_unique" ON "voters" ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_national_id_live_unique" ON "registrations" ("national_id") WHERE "status" <> 'REJECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_email_live_unique" ON "registrations" ("email") WHERE "status" <> 'REJECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_public_key_live_unique" ON "registrations" ("public_key") WHERE "status" <> 'REJECTED';--> statement-breakpoint
CREATE INDEX "registrations_status_created_idx" ON "registrations" ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "election_eligibility_election_voter_unique" ON "election_eligibility" ("election_id","voter_id");--> statement-breakpoint
CREATE INDEX "election_eligibility_voter_idx" ON "election_eligibility" ("voter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_members_ring_voter_unique" ON "ring_members" ("ring_id","voter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_members_ring_position_unique" ON "ring_members" ("ring_id","position_in_ring");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_members_election_voter_unique" ON "ring_members" ("election_id","voter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_members_ring_public_key_unique" ON "ring_members" ("ring_id","public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rings_election_index_unique" ON "rings" ("election_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "rings_id_election_unique" ON "rings" ("id","election_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ballot_access_tokens_election_voter_unique" ON "ballot_access_tokens" ("election_id","voter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ballot_access_tokens_hash_unique" ON "ballot_access_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "ballot_access_tokens_dispatch_idx" ON "ballot_access_tokens" ("election_id","email_status");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_admin_id_admins_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_election_id_elections_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_election_id_elections_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_voter_id_voters_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "voters"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "election_eligibility" ADD CONSTRAINT "election_eligibility_election_id_elections_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "election_eligibility" ADD CONSTRAINT "election_eligibility_voter_id_voters_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "voters"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ring_members" ADD CONSTRAINT "ring_members_ring_fk" FOREIGN KEY ("ring_id","election_id") REFERENCES "rings"("id","election_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ring_members" ADD CONSTRAINT "ring_members_eligibility_fk" FOREIGN KEY ("election_id","voter_id") REFERENCES "election_eligibility"("election_id","voter_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "rings" ADD CONSTRAINT "rings_election_id_elections_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ballot_access_tokens" ADD CONSTRAINT "ballot_access_tokens_election_id_elections_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ballot_access_tokens" ADD CONSTRAINT "ballot_access_tokens_voter_id_voters_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "voters"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ballot_access_tokens" ADD CONSTRAINT "ballot_access_tokens_eligibility_fk" FOREIGN KEY ("election_id","voter_id") REFERENCES "election_eligibility"("election_id","voter_id") ON DELETE RESTRICT;