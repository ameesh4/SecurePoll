import type { Request, Response } from "express";
import {
  getRegistrationStatus,
  submitRegistration,
} from "../../services/registration.service";
import { parse } from "../middleware/validate";
import { registrationSubmissionSchema, uuidParamSchema } from "../schemas";

/**
 * Voter registration. Unauthenticated by design — this is the front door of the system.
 *
 * The body carries a public key only. There is no field here, and must never be one, for a
 * private key, seed, or mnemonic: the keypair is generated on the voter's device and the
 * secret half never leaves it.
 */
export async function register(req: Request, res: Response): Promise<void> {
  const submission = parse(registrationSubmissionSchema, req.body);
  const registration = await submitRegistration(submission);

  // Only the receipt goes back. Echoing the stored record would let anyone confirm what
  // the server holds for a given national id.
  res.status(201).json({
    data: {
      id: registration.id,
      status: registration.status,
      submittedAt: registration.createdAt,
    },
  });
}

/**
 * The voter's own status page. Authorised by possession of the registration id, which reaches
 * only the person who submitted the form.
 *
 * The response omits the national id, the email and the public key — everything the caller
 * already typed and nothing they did not — so a leaked link discloses strictly less than the
 * submission it followed.
 */
export async function registrationStatus(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await getRegistrationStatus(id) });
}
