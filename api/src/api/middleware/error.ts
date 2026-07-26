import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  // Anything reaching here is a bug rather than a rejected request, so the response says
  // nothing about it beyond that it happened.
  console.error("[api] unhandled error:", error);
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
      ...(env.NODE_ENV === "development" && {
        details: error instanceof Error ? error.message : String(error),
      }),
    },
  });
}
