import { Router } from "express";
import adminRoutes from "./admin";
import publicRoutes from "./public.routes";

const router = Router();

router.use(publicRoutes);
router.use("/admin", adminRoutes);

export default router;
