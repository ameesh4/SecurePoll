import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { adminRole } from "./enums";

/**
 * Verification-server operators. There is no self-service signup: admins are created out of
 * band by the seed script, because the ability to approve a registration is the ability to
 * add a voter to an election.
 */
export const admins = pgTable(
  "admins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Stored lowercase; normalise before insert so the unique index is meaningful. */
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    /**
     * Defaults to the lesser role. A new admin can vet registrations and edit drafts the
     * moment they are created; the ability to take an irreversible step has to be granted
     * deliberately.
     */
    role: adminRole("role").notNull().default("REVIEWER"),
    /**
     * Checked on every authenticated request. Sessions are stateless JWTs, so clearing this
     * flag is the only way to cut off an admin before their token expires.
     */
    isActive: boolean("is_active").notNull().default(true),

    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("admins_email_unique").on(t.email)],
);

export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
