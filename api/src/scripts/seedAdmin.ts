import { createInterface } from "node:readline/promises";
import { createAdmin, findAdminByEmail } from "../db/repository/admins.repository";
import { hashPassword } from "../lib/password";

/**
 * Creates the first admin. There is no signup endpoint on purpose: approving a registration
 * mints a voter, so account creation is an out-of-band operation performed by whoever
 * controls the server.
 *
 * Usage: bun run db:seed-admin
 */
async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const name = (await rl.question("Name: ")).trim();
    const email = (await rl.question("Email: ")).trim().toLowerCase();
    const password = (await rl.question("Password (min 12 chars): ")).trim();
    const roleAnswer = (
      await rl.question("Super-admin? Required to freeze groups and open voting (y/N): ")
    )
      .trim()
      .toLowerCase();
    const role = roleAnswer === "y" || roleAnswer === "yes" ? "SUPER_ADMIN" : "REVIEWER";

    if (!name || !email || !password) {
      throw new Error("All fields are required");
    }
    if (password.length < 12) {
      throw new Error("Password must be at least 12 characters");
    }
    if (await findAdminByEmail(email)) {
      throw new Error(`An admin with email ${email} already exists`);
    }

    const admin = await createAdmin({
      name,
      email,
      role,
      passwordHash: await hashPassword(password),
    });

    console.log(`\nCreated ${admin.role} ${admin.email} (${admin.id})`);
  } finally {
    rl.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
