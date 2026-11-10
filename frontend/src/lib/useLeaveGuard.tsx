import { useEffect, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";

export interface LeaveGuardOptions {
  /** True while there is unsaved work. */
  when: boolean;
  title: string;
  description: ReactNode;
  /** Label of the button that leaves anyway. */
  leaveLabel: string;
  /** Runs just before the navigation goes ahead (discard drafts, cancel a staged import). */
  onLeave?: () => void;
}

/**
 * Blocks in-app navigation (sidebar, shortcuts, back button) while `when` is true and
 * asks "Stay" or "Leave". Reloads and tab closes get the browser's own prompt.
 * Needs a data router (`createBrowserRouter`). Render the returned node once in the page.
 */
export function useLeaveGuard({ when, title, description, leaveLabel, onLeave }: LeaveGuardOptions): ReactNode {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!when) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [when]);

  // The work was resolved while the prompt was open (saved, confirmed): let go.
  useEffect(() => {
    if (!when && blocker.state === "blocked") blocker.proceed();
  }, [when, blocker]);

  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => blocker.state === "blocked" && blocker.reset()}>
            Stay here
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (blocker.state !== "blocked") return;
              onLeave?.();
              blocker.proceed();
            }}
          >
            {leaveLabel}
          </Button>
        </>
      }
    />
  );
}
