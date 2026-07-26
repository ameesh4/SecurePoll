import { Router } from "express";
import {
  approveRegistrationById,
  approveRegistrationsBulk,
  getRegistration,
  listRegistrations,
  rejectRegistrationById,
  rejectRegistrationsBulk,
} from "../../controllers/adminRegistrations.controller";

const router = Router();

router.get("/", listRegistrations);

// Registered before `/:id/...` so "bulk" is never parsed as a registration id.
router.post("/bulk/approve", approveRegistrationsBulk);
router.post("/bulk/reject", rejectRegistrationsBulk);

router.get("/:id", getRegistration);
router.post("/:id/approve", approveRegistrationById);
router.post("/:id/reject", rejectRegistrationById);

export default router;
