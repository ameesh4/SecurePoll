import cors from "cors";
import express, { type Request, type Response } from "express";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./api/middleware/error";
import router from "./api/routes/router";

export const app = express();

app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static("public"));

app.get("/api/v1/health", (_req: Request, res: Response) => {
  res.status(200).json({ data: { status: "ok" } });
});

app.use("/api/v1", router);

// Both must stay last: Express matches in registration order, and an error handler is only
// reached by errors thrown downstream of it.
app.use(notFoundHandler);
app.use(errorHandler);
