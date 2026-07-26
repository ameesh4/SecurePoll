import { Router } from "express";
import {
  getCurrentAdmin,
  loginAdmin,
  logoutAdmin,
} from "../../controllers/adminAuth.controller";
import { changePasswordHandler } from "../../controllers/admins.controller";
import { requireAdmin } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";

const router = Router();

router.post(
  "/login",
  rateLimit({ name: "admin-login", windowMs: 15 * 60 * 1000, max: 10 }),
  loginAdmin,
);

router.post("/logout", requireAdmin, logoutAdmin);
router.get("/me", requireAdmin, getCurrentAdmin);

/**
 * Changing your own password. Available to every operator, not just super-admins — it only affects
 * the caller's own account, and a new operator needs it to replace the initial password whoever
 * created their account was shown.
 */
router.post(
  "/password",
  requireAdmin,
  rateLimit({ name: "admin-password", windowMs: 15 * 60 * 1000, max: 10 }),
  changePasswordHandler,
);

export default router;
