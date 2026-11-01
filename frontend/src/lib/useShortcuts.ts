import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { NAV_ITEMS } from "./nav";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Desktop shortcuts: "g" then a letter navigates, "/" focuses search, "?" opens help. */
export function useShortcuts(onHelp: () => void, enabled: boolean) {
  const navigate = useNavigate();
  const pending = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const clear = () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (pending.current !== null) {
        const target = NAV_ITEMS.find((i) => i.shortcut === e.key);
        clear();
        if (target) {
          e.preventDefault();
          navigate(target.to);
        }
        return;
      }
      if (e.key === "g") {
        pending.current = window.setTimeout(clear, 1000);
      } else if (e.key === "/") {
        const search = document.querySelector<HTMLElement>("[data-search]");
        if (search) {
          e.preventDefault();
          search.focus();
        }
      } else if (e.key === "?") {
        e.preventDefault();
        onHelp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clear();
    };
  }, [enabled, navigate, onHelp]);
}
