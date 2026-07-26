import type { ElectionStatus } from "../api/types";
import { LIFECYCLE_STAGES } from "./lifecycle";
import { Label } from "./primitives";

/**
 * The lifecycle state machine, rendered as a persistent rail.
 *
 * It appears on every election screen for one reason: which actions are legal depends entirely on
 * which stage the election is in, and an admin who has to remember that will eventually reach for
 * something the server refuses. The rail makes the answer ambient.
 */

function formatDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export default function LifecycleRail({
  status,
  registrationClosesAt = null,
  votingOpensAt = null,
  votingClosesAt = null,
}: {
  status: ElectionStatus;
  registrationClosesAt?: string | null;
  votingOpensAt?: string | null;
  votingClosesAt?: string | null;
}) {
  // A cancelled election is off the spine entirely rather than parked at some stage of it, so the
  // rail says so instead of highlighting a stage it never reached.
  if (status === "CANCELLED") {
    return (
      <div className="px-7 py-4 border-b-2 border-ink/40 bg-surface">
        <Label>Cancelled</Label>
        <p className="text-[12.5px] m-0 mt-1">
          This election was cancelled and cannot be advanced.
        </p>
      </div>
    );
  }

  const currentIndex = LIFECYCLE_STAGES.findIndex((stage) => stage.status === status);
  const dates: Partial<Record<ElectionStatus, string | null>> = {
    REGISTRATION_OPEN: formatDate(registrationClosesAt),
    VOTING_OPEN: formatDate(votingOpensAt),
    VOTING_CLOSED: formatDate(votingClosesAt),
  };

  return (
    <ol
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 list-none m-0 p-0 border-b-2 border-ink/40"
      aria-label="Election lifecycle"
    >
      {LIFECYCLE_STAGES.map((stage, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        const topRule = current
          ? "border-t-accent"
          : done
            ? "border-t-ink"
            : "border-t-neutral-300";

        return (
          <li
            key={stage.status}
            aria-current={current ? "step" : undefined}
            className={`px-4.5 py-4 border-t-4 ${topRule} ${
              current ? "bg-accent-100" : ""
            } lg:[&:not(:last-child)]:border-r lg:[&:not(:last-child)]:border-r-ink/40`}
          >
            <Label accent={current}>
              {String(index + 1).padStart(2, "0")}
              {current ? " · current" : done ? " · done" : ""}
            </Label>
            <div
              className={`font-extrabold text-[14px] mt-1 ${done || current ? "" : "opacity-50"}`}
            >
              {stage.label}
            </div>
            <div className={`text-[11px] ${current ? "text-accent-700" : "text-ink/55"}`}>
              {dates[stage.status] ?? stage.note}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
