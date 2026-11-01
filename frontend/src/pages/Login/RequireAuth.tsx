import { Navigate, Outlet, useLocation } from "react-router";
import { Skeleton } from "../../components/Skeleton";
import { useAuthMe } from "../../lib/queries";

/** Route guard: wrap protected routes; redirects to /login?next=… when signed out. */
export function RequireAuth({ children }: { children?: React.ReactNode }) {
  const me = useAuthMe();
  const location = useLocation();

  if (me.data?.authenticated) return <>{children ?? <Outlet />}</>;
  if (me.isPending) return <Skeleton height="200px" />;
  if (me.data && !me.data.authenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  // Probe failed (offline / server down): keep cached pages usable.
  return <>{children ?? <Outlet />}</>;
}
