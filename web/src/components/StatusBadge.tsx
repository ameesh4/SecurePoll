import type { RegistrationStatus } from "../api/types";

const CLASS_BY_STATUS: Record<RegistrationStatus, string> = {
  PENDING: "inline-flex items-center text-[11px] font-semibold tracking-wide uppercase px-2.5 py-0.5 bg-accent-100 text-accent-800",
  APPROVED:
    "inline-flex items-center text-[11px] font-semibold tracking-wide uppercase px-2.5 py-0.5 bg-neutral-100 text-neutral-800",
  REJECTED:
    "inline-flex items-center text-[11px] font-semibold tracking-wide uppercase px-2.5 py-0.5 border border-accent text-accent bg-transparent",
};

export default function StatusBadge({ status }: { status: RegistrationStatus }) {
  return <span className={CLASS_BY_STATUS[status]}>{status.toLowerCase()}</span>;
}
