import bcrypt from "bcryptjs";
import { env } from "../config/env";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Hashing a throwaway value so that a login attempt for an unknown email costs the same as
 * one for a known email. Without it, response timing tells an attacker which admin
 * addresses exist.
 */
const DUMMY_HASH = bcrypt.hashSync("timing-equalisation-placeholder", 12);

export async function fakeVerify(): Promise<void> {
  await bcrypt.compare("timing-equalisation-placeholder", DUMMY_HASH);
}
