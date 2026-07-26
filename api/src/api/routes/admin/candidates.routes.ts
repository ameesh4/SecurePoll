import { Router } from "express";
import {
  deleteCandidateHandler,
  updateCandidateHandler,
} from "../../controllers/candidates.controller";

/**
 * Candidate routes keyed by candidate id rather than nested under an election, matching the
 * API sketch in the project context. The election is resolved from the candidate row, and the
 * immutability check runs against that election's state — so a candidate cannot be edited via
 * this path once its election has moved past REGISTRATION_OPEN.
 */
const router = Router();

router.patch("/:id", updateCandidateHandler);
router.delete("/:id", deleteCandidateHandler);

export default router;
