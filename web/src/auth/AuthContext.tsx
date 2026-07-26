import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getToken, setToken } from "../api/client";
import { fetchCurrentAdmin, login as loginRequest } from "../api/endpoints";
import type { AdminProfile } from "../api/types";
import { AuthContext, type AuthState } from "./context";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminProfile | null>(null);
  // Seeded from storage during the first render rather than in an effect, so a visitor with
  // no token never flashes the loading state.
  const [status, setStatus] = useState<AuthState["status"]>(() =>
    getToken() ? "loading" : "anonymous",
  );

  // A stored token only means we once had a session. It may have expired, or the admin may
  // have been deactivated since, so the server is asked before it is trusted.
  useEffect(() => {
    if (!getToken()) return;

    const controller = new AbortController();

    fetchCurrentAdmin(controller.signal).then(
      (profile) => {
        setAdmin(profile);
        setStatus("authenticated");
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setToken(null);
        setAdmin(null);
        setStatus("anonymous");
      },
    );

    return () => controller.abort();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    setToken(result.token);
    setAdmin(result.admin);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(() => {
    // The token is a stateless JWT, so this is a client-side discard. Cutting an admin off
    // before their token expires means deactivating them server-side.
    setToken(null);
    setAdmin(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo(
    () => ({ admin, status, login, logout }),
    [admin, status, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
