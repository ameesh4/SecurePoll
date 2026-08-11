import { Router } from "express";
import {
  changeBallotRecipient,
  dispatchBallotAccess,
  issueBallotAccess,
  listBallotAccess,
  resendBallotAccess,
  retryBallotAccess,
} from "../../controllers/ballotAccess.controller";
import { listElectionAudit } from "../../controllers/audit.controller";
import {
  createCandidateHandler,
  listCandidatesHandler,
  reorderCandidatesHandler,
} from "../../controllers/candidates.controller";
import {
  createElectionHandler,
  getElection,
  listAllElections,
  listAvailableVoters,
  listVoters,
  monitoring,
  previewTransitionHandler,
  transitionElectionHandler,
  updateEligibility,
  updateEligibilityBulk,
  updateElectionHandler,
} from "../../controllers/elections.controller";
import {
  exportChainManifestHandler,
  formRingsHandler,
  listRingsHandler,
  previewPublishHandler,
  previewRings,
  publishRingsHandler,
} from "../../controllers/rings.controller";

const router = Router();

router.get("/", listAllElections);
router.post("/", createElectionHandler);
router.get("/:id", getElection);
router.patch("/:id", updateElectionHandler);

// Preview is a GET because it writes nothing; the transition itself is a POST and re-checks
// every guard under a row lock.
router.get("/:id/transition", previewTransitionHandler);
router.post("/:id/transition", transitionElectionHandler);

router.get("/:id/candidates", listCandidatesHandler);
router.post("/:id/candidates", createCandidateHandler);
router.post("/:id/candidates/reorder", reorderCandidatesHandler);

router.get("/:id/voters", listVoters);
// Registered before the bare "/:id/voters" pattern would matter; "available" is a fixed segment
// so there is no ambiguity, but keeping them adjacent makes the pair obvious.
router.get("/:id/voters/available", listAvailableVoters);
router.post("/:id/eligibility", updateEligibility);
router.post("/:id/eligibility/bulk", updateEligibilityBulk);

router.get("/:id/rings/preview", previewRings);
router.post("/:id/rings/form", formRingsHandler);
router.get("/:id/rings", listRingsHandler);
router.get("/:id/rings/publish", previewPublishHandler);
router.post("/:id/rings/publish", publishRingsHandler);

// The manifest each ledger node imports from disk. Available from RINGS_FROZEN onwards so an
// extra node can be brought up mid-election with the same electorate the others hold.
router.get("/:id/chain-manifest", exportChainManifestHandler);

router.get("/:id/ballot-access", listBallotAccess);
router.post("/:id/ballot-access/issue", issueBallotAccess);
router.post("/:id/ballot-access/dispatch", dispatchBallotAccess);
router.post("/:id/ballot-access/retry", retryBallotAccess);

router.get("/:id/monitoring", monitoring);
router.get("/:id/audit", listElectionAudit);

export default router;

/**
 * Ballot-access actions that address one recipient rather than a whole election. Mounted at
 * the top level because the id in the path is the credential's, not the election's.
 */
export const ballotAccessRouter = Router();
ballotAccessRouter.post("/:id/resend", resendBallotAccess);
ballotAccessRouter.patch("/:id/recipient", changeBallotRecipient);
