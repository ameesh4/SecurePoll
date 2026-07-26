import { createContext } from "react";
import type { AdminProfile } from "../api/types";

export interface AuthState {
  admin: AdminProfile | null;
  status: "loading" | "authenticated" | "anonymous";
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);
