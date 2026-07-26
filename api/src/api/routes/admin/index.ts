import { Router } from "express";
import { listAudit } from "../../controllers/audit.controller";
import {
  listKeyRotations,
  reviewKeyRotation,
} from "../../controllers/keyRotation.controller";
import { dashboard } from "../../controllers/elections.controller";
import { requireAdmin } from "../../middleware/auth";
import adminAccountRoutes from "./admins.routes";
import authRoutes from "./auth.routes";
import candidateRoutes from "./candidates.routes";
import electionRoutes, { ballotAccessRouter } from "./elections.routes";
import registrationRoutes from "./registrations.routes";

const router = Router();

// Login must stay reachable without a token; everything else is gated.
router.use("/auth", authRoutes);

router.get("/dashboard", requireAdmin, dashboard);
router.use("/admins", requireAdmin, adminAccountRoutes);
router.use("/registrations", requireAdmin, registrationRoutes);
router.use("/elections", requireAdmin, electionRoutes);
router.use("/candidates", requireAdmin, candidateRoutes);
router.use("/ballot-access", requireAdmin, ballotAccessRouter);
router.get("/key-rotations", requireAdmin, listKeyRotations);
router.post("/key-rotations/:id/review", requireAdmin, reviewKeyRotation);
router.get("/audit", requireAdmin, listAudit);

export default router;
