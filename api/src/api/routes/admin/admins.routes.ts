import { Router } from "express";
import {
  createAdminHandler,
  listAdminsHandler,
  updateAdminHandler,
} from "../../controllers/admins.controller";
import { requireSuperAdmin } from "../../middleware/auth";

/**
 * Operator accounts. Closed to reviewers at the router, on top of the service-level checks — the
 * ability to create an account is the ability to grant somebody the ability to enfranchise voters.
 */
const router = Router();

router.use(requireSuperAdmin);

router.get("/", listAdminsHandler);
router.post("/", createAdminHandler);
router.patch("/:id", updateAdminHandler);

export default router;
