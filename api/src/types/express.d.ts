import type { AdminProfile } from "../services/adminAuth.service";

declare global {
  namespace Express {
    interface Request {
      /** Set by the requireAdmin middleware; absent on unauthenticated routes. */
      admin?: AdminProfile;
    }
  }
}

export {};
