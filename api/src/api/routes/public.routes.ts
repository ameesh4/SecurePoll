import { Router } from "express";
import { retrieveRing } from "../controllers/ballotAccess.controller";
import { replaceKey } from "../controllers/keyRotation.controller";
import {
  register,
  registrationStatus,
} from "../controllers/registration.controller";
import { rateLimit } from "../middleware/rateLimit";

const router = Router();

router.post(
  "/register",
  rateLimit({ name: "register", windowMs: 60 * 60 * 1000, max: 10 }),
  register,
);

/**
 * The voter's own status page, reached from the link in their confirmation email. Rate-limited
 * because the id in the path is the only thing authorising the read — a generous limit would
 * make enumeration cheap, even though a v4 UUID space is not realistically walkable.
 */
router.get(
  "/register/:id",
  rateLimit({ name: "registration-status", windowMs: 60 * 1000, max: 30 }),
  registrationStatus,
);

/**
 * Replacing a lost voting key. Limited per registration rather than per IP: the risk being managed
 * is somebody hammering *one* voter's record, and an IP bucket would let one student on campus wifi
 * exhaust the allowance for everyone else behind the same address.
 */
router.post(
  "/register/:id/key",
  rateLimit({
    name: "key-replacement",
    windowMs: 60 * 60 * 1000,
    max: 8,
    // Express types params as possibly-array; the route pattern only ever yields a string.
    keyBy: (req) => (typeof req.params.id === "string" ? req.params.id : undefined),
  }),
  replaceKey,
);

/**
 * Ballot retrieval. Rate-limited hard: the body carries a bearer credential, and this is the
 * one unauthenticated endpoint where a valid guess would be worth something.
 */
router.post(
  "/ring",
  rateLimit({ name: "ring", windowMs: 60 * 1000, max: 10 }),
  retrieveRing,
);

export default router;
