import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../auth/useAuth";
import { hint } from "../ui/classes";

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="grid place-items-center min-h-screen">
        <span className={hint}>Checking your session…</span>
      </div>
    );
  }

  if (status === "anonymous") {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
