import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { invalidateAuth, logout } from "./auth";

/** The one sign-out path: end the session, wipe client data, refresh auth, go to /login. */
export function useSignOut(): () => Promise<void> {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    await logout();
    await invalidateAuth(qc);
    navigate("/login");
  }, [qc, navigate]);
}
