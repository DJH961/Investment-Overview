import clsx from "clsx";
import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { holdDelay, splitAtStep, stepDecimal, toDp } from "../../lib/settleMath";
import "./Stepper.scss";

export interface StepperProps {
  label: string;
  value: string;
  /** Decimals the ledger holds for this figure: a step moves the last one. */
  dp: number;
  /** 10 moves the digit one place to the left (the "x10" toggle). */
  mult?: 1 | 10;
  prefix?: string;
  suffix?: string;
  /** Called with the new figure (already at `dp` places). */
  onChange: (next: string) => void;
  /** A derived figure the owner may still nudge. */
  hint?: string;
}

/**
 * A figure with big − / + buttons that move its last stored decimal (press and hold
 * repeats, gently accelerating). The digit a step moves is subtly marked; tapping the
 * value lets you type it instead. 44 px targets; keyboard: Tab to a button, Enter or
 * Space steps once, and the typed field takes Arrow Up / Down.
 */
export function Stepper({ label, value, dp, mult = 1, prefix, suffix, onChange, hint }: StepperProps) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(value);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeats = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const stepOnce = useCallback(
    (dir: 1 | -1) => {
      const next = stepDecimal(valueRef.current, dp, dir, mult);
      valueRef.current = next;
      onChange(next);
    },
    [dp, mult, onChange],
  );

  const start = (dir: 1 | -1) => {
    stop();
    repeats.current = 0;
    stepOnce(dir);
    const tick = () => {
      timer.current = setTimeout(() => {
        stepOnce(dir);
        repeats.current += 1;
        tick();
      }, holdDelay(repeats.current));
    };
    tick();
  };

  const commit = () => {
    setTyping(false);
    const next = toDp(draft, dp);
    if (next !== "") onChange(next);
  };

  const parts = splitAtStep(value || toDp("0", dp), mult);
  const buttonProps = (dir: 1 | -1) => ({
    // Pointer: press and hold. Keyboard (detail 0): one step per Enter / Space.
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start(dir);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) stepOnce(dir);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  const unit = (10 ** -(mult === 10 ? dp - 1 : dp)).toFixed(Math.max(0, mult === 10 ? dp - 1 : dp));

  return (
    <div className="stepper">
      <span className="stepper__label">{label}</span>
      <div className="stepper__row">
        <button type="button" className="stepper__btn" aria-label={`${label}: decrease by ${unit}`} {...buttonProps(-1)}>
          <Minus aria-hidden />
        </button>
        {typing ? (
          <input
            className="stepper__input"
            inputMode="decimal"
            aria-label={label}
            value={draft}
            ref={inputRef}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setTyping(false);
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const next = stepDecimal(draft, dp, e.key === "ArrowUp" ? 1 : -1, mult);
                setDraft(next);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className={clsx("stepper__value", "money")}
            aria-label={`${label}: ${value}. Tap to type a value`}
            onClick={() => {
              setDraft(value);
              setTyping(true);
            }}
          >
            {prefix && <span className="stepper__affix">{prefix}</span>}
            <span aria-hidden>
              {parts.head}
              <span className="stepper__digit">{parts.digit}</span>
              {parts.tail}
            </span>
            {suffix && <span className="stepper__affix">{suffix}</span>}
          </button>
        )}
        <button type="button" className="stepper__btn" aria-label={`${label}: increase by ${unit}`} {...buttonProps(1)}>
          <Plus aria-hidden />
        </button>
      </div>
      {hint && <span className="stepper__hint">{hint}</span>}
    </div>
  );
}
