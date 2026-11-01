import { Dialog, Popover } from "radix-ui";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useLocation } from "react-router";
import { Button } from "../Button";
import { TOUR_STEPS, type TourStep } from "./steps";
import "./Tour.scss";

const SEEN_KEY = "iv.tour.seen";
const REPLAY_KEY = "iv.tour.replay";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** First visible element matching the selector, or null. */
function findTarget(step: TourStep): HTMLElement | null {
  if (!step.selector) return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(step.selector));
  return nodes.find((n) => n.getClientRects().length > 0) ?? null;
}

function focusNext(e: Event) {
  e.preventDefault();
  document.querySelector<HTMLElement>("[data-tour-next]")?.focus();
}

/** Replayable guided tour; starts on first visit after login or when `iv.tour.replay=1`. */
export function Tour() {
  const { pathname } = useLocation();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  const onLogin = pathname === "/login";

  // Start check on every navigation (covers login -> app and Help's replay button).
  const [seenPath, setSeenPath] = useState<string | null>(null);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    if (!onLogin && !active && (safeGet(REPLAY_KEY) === "1" || safeGet(SEEN_KEY) !== "1")) {
      safeRemove(REPLAY_KEY);
      setIndex(0);
      setActive(true);
    }
  }

  const step = TOUR_STEPS[index];

  useEffect(() => {
    if (!active) return;
    const update = () => setTarget(findTarget(step));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [active, step]);

  const close = useCallback(() => {
    safeSet(SEEN_KEY, "1");
    safeRemove(REPLAY_KEY);
    setActive(false);
  }, []);

  const last = index === TOUR_STEPS.length - 1;
  const next = useCallback(() => (last ? close() : setIndex((i) => i + 1)), [last, close]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    },
    [next, back],
  );

  const virtualRef = useMemo(() => ({ current: target }), [target]);

  if (!active || onLogin) return null;

  const body = (
    <>
      <p className="tour__progress">
        Step {index + 1} of {TOUR_STEPS.length}
      </p>
      <p className="tour__body">{step.body}</p>
      <div className="tour__actions">
        <Button variant="ghost" size="sm" onClick={close}>
          Skip
        </Button>
        {index > 0 && (
          <Button variant="secondary" size="sm" onClick={back}>
            Back
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={next} data-tour-next>
          {last ? "Done" : "Next"}
        </Button>
      </div>
    </>
  );

  if (target) {
    return (
      <Popover.Root open onOpenChange={(o) => !o && close()}>
        <Popover.Anchor virtualRef={virtualRef} />
        <Popover.Portal>
          <Popover.Content
            className="tour__card"
            side="right"
            align="start"
            sideOffset={12}
            collisionPadding={12}
            aria-label="Guided tour"
            onKeyDown={onKeyDown}
            onOpenAutoFocus={focusNext}
          >
            <h2 className="tour__title">{step.title}</h2>
            {body}
            <Popover.Arrow className="tour__arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="tour__overlay" />
        <Dialog.Content className="tour__card tour__card--centred" onKeyDown={onKeyDown} onOpenAutoFocus={focusNext} aria-describedby={undefined}>
          <Dialog.Title className="tour__title">{step.title}</Dialog.Title>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
