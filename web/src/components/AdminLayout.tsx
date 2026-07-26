import { useCallback } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { fetchDashboard, fetchKeyRotations } from "../api/endpoints";
import { useAuth } from "../auth/useAuth";
import { useAsyncData } from "../hooks/useAsyncData";
import { btnSecondary } from "../ui/classes";
import { Tag } from "./primitives";

const NAV = [
  { to: "/admin", label: "Dashboard", end: true, badge: null },
  { to: "/admin/elections", label: "Elections", end: false, badge: null },
  { to: "/admin/registrations", label: "Verification queue", end: false, badge: "pending" },
  { to: "/admin/key-replacements", label: "Key replacements", end: false, badge: "rotations" },
  { to: "/admin/audit", label: "Audit record", end: false, badge: null },
  // Managing operator accounts is a super-admin power, so the entry is hidden from reviewers. That
  // is presentation only — the route and the API both refuse them.
  {
    to: "/admin/operators",
    label: "Operators",
    end: false,
    badge: null,
    superAdminOnly: true,
  },
] satisfies {
  to: string;
  label: string;
  end: boolean;
  badge: "pending" | "rotations" | null;
  superAdminOnly?: boolean;
}[];

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? "block px-4.5 py-2.5 text-[13px] no-underline bg-accent-100 text-accent-700 font-semibold shadow-[inset_3px_0_0_var(--color-accent)]"
    : "block px-4.5 py-2.5 text-[13px] no-underline text-ink/70 hover:bg-ink/5 hover:text-ink";
}

/**
 * The admin shell: a fixed rail on the left, everything else in the pane on the right.
 *
 * The pending-review count is loaded here rather than passed down, because it belongs to the
 * navigation rather than to any one screen — an admin watching the monitoring page still needs
 * to see the queue filling up. Its errors are swallowed deliberately: a badge that failed to
 * load is not worth an error banner across the whole shell.
 */
export default function AdminLayout() {
  const { admin, logout } = useAuth();
  const navigate = useNavigate();

  const load = useCallback((signal: AbortSignal) => fetchDashboard(signal), []);
  const { data } = useAsyncData(load, () => "");

  // Voters waiting on a key replacement cannot vote until somebody looks at it, so the count sits
  // in the navigation next to the review queue rather than only on its own page.
  const loadRotations = useCallback(
    (signal: AbortSignal) => fetchKeyRotations({ page: 1, pageSize: 1 }, signal),
    [],
  );
  const rotations = useAsyncData(loadRotations, () => "");

  function handleLogout() {
    logout();
    navigate("/admin/login", { replace: true });
  }

  const counts = {
    pending: data?.pendingRegistrations ?? 0,
    rotations: rotations.data?.total ?? 0,
  };

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[212px_1fr] bg-bg">
      {/*
        The rail pins to the top of the viewport while the pane beside it scrolls.

        `self-start` is the part that makes it work: a grid item stretches to its row by default,
        so a sticky rail would already span the whole scroll range and have nowhere to move.
        Pinning it to `h-screen` instead gives it somewhere to stick, and `overflow-y-auto` keeps
        "Sign out" reachable on a short viewport rather than letting it fall off the bottom.

        Sticky only from `md` up — on a narrow screen the rail sits above the content as a normal
        block, and pinning it there would eat the height the content needs.
      */}
      <div className="flex flex-col border-b-2 md:border-b-0 md:border-r-2 border-ink/40 py-5 md:sticky md:top-0 md:self-start md:h-screen md:overflow-y-auto">
        <Link
          to="/admin"
          className="px-4.5 pb-5 no-underline text-inherit font-extrabold text-[17px] tracking-[-0.02em]"
        >
          SECURE<span className="text-accent">POLL</span>
        </Link>

        <nav className="flex flex-col" aria-label="Admin sections">
          {NAV.filter(
            (item) => !("superAdminOnly" in item) || admin?.role === "SUPER_ADMIN",
          ).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              <span className="flex items-center justify-between gap-2">
                {item.label}
                {item.badge && counts[item.badge] > 0 ? (
                  <span className="text-accent font-semibold tabular-nums">
                    {counts[item.badge]}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-4.5 pt-4 border-t-2 border-ink/40">
          {admin ? (
            <>
              <div className="text-[13px] font-semibold">{admin.name}</div>
              <div className="text-[11px] text-ink/55 break-all mb-1.5">{admin.email}</div>
              <Tag tone={admin.role === "SUPER_ADMIN" ? "accent" : "neutral"}>
                {admin.role === "SUPER_ADMIN" ? "Super-admin" : "Reviewer"}
              </Tag>
            </>
          ) : null}
          <button
            type="button"
            className={`${btnSecondary} mt-3 w-full`}
            onClick={handleLogout}
          >
            Sign out
          </button>
        </div>
      </div>

      <main className="min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
