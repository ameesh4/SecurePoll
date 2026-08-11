ALTER TABLE "elections" ADD COLUMN "chain_root_ip" text;--> statement-breakpoint
ALTER TABLE "elections" ADD COLUMN "chain_root_port" integer;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_chain_root_port_range" CHECK ("chain_root_port" is null or ("chain_root_port" > 0 and "chain_root_port" <= 65535));