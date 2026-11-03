import { Navigate, Outlet, useLocation } from "react-router";
import { Skeleton } from "../../components/Skeleton";
import { hadSignedInSession, useAuthMe } from "../../lib/queries";

/** Route guard: wrap protected routes; redirects to /login?next=… when signed out. */
export function RequireAuth({ children }: { children?: React.ReactNode }) {
  const me = useAuthMe();
  const location = useLocation();
  const content = <>{children ?? <Outlet />}</>;

  if (me.data?.authenticated) return content;
  if (me.data && !me.data.authenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  // Still asking the server. If this browser was signed in, show the cached app
  // right away (a reload on a slow or dropped connection must not hang here);
  // the probe redirects to /login afterwards if the session really ended. A
  // paused probe (browser offline) also shows the app with its offline banner.
  if (me.isPending && me.fetchStatus === "fetching" && !hadSignedInSession()) return <Skeleton height="200px" />;
  // Probe failed (offline / server down): keep cached pages usable.
  return content;
}
