import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import { UnauthorizedError } from "./errors";

const ISSUER = "securepoll-verification-server";
const AUDIENCE = "securepoll-admin";

const adminClaimsSchema = z.object({
  sub: z.uuid(),
  email: z.string(),
});

export type AdminClaims = z.infer<typeof adminClaimsSchema>;

export function signAdminToken(claims: AdminClaims): { token: string; expiresIn: number } {
  const token = jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { token, expiresIn: env.JWT_TTL_SECONDS };
}

export function verifyAdminToken(token: string): AdminClaims {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch {
    throw new UnauthorizedError("Session is invalid or has expired");
  }

  const claims = adminClaimsSchema.safeParse(decoded);
  if (!claims.success) {
    throw new UnauthorizedError("Session is invalid or has expired");
  }
  return claims.data;
}
