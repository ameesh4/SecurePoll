CREATE TYPE "key_rotation_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "key_rotation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"registration_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"new_public_key" text NOT NULL,
	"previous_public_key" text NOT NULL,
	"status" "key_rotation_status" DEFAULT 'PENDING'::"key_rotation_status" NOT NULL,
	"reason" text,
	"rejection_reason" text,
	"reviewed_by_admin_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_rotation_requests_rejection_reason_required" CHECK ("status" <> 'REJECTED' or "rejection_reason" is not null),
	CONSTRAINT "key_rotation_requests_review_matches_status" CHECK (("status" = 'PENDING') = ("reviewed_at" is null)),
	CONSTRAINT "key_rotation_requests_key_actually_changes" CHECK ("new_public_key" <> "previous_public_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "key_rotation_requests_one_pending_per_voter" ON "key_rotation_requests" ("voter_id") WHERE "status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "key_rotation_requests_status_created_idx" ON "key_rotation_requests" ("status","created_at");--> statement-breakpoint
CREATE INDEX "key_rotation_requests_voter_idx" ON "key_rotation_requests" ("voter_id");--> statement-breakpoint
ALTER TABLE "key_rotation_requests" ADD CONSTRAINT "key_rotation_requests_registration_id_registrations_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "key_rotation_requests" ADD CONSTRAINT "key_rotation_requests_voter_id_voters_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "voters"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "key_rotation_requests" ADD CONSTRAINT "key_rotation_requests_reviewed_by_admin_id_admins_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT;