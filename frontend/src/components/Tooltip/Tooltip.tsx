import { Tooltip as RadixTooltip } from "radix-ui";
import { useState, type ReactNode } from "react";
import "./Tooltip.scss";

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element; rendered via asChild. */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Hover / focus tooltip that also opens on tap: Radix tooltips are hover-only,
 * so on a phone the (i) buttons did nothing. A tap opens it; tapping anywhere
 * else (or Escape) closes it.
 */
export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root open={open} onOpenChange={setOpen}>
        <RadixTooltip.Trigger
          asChild
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
        >
          {children}
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="tooltip__content"
            side={side}
            sideOffset={6}
            collisionPadding={12}
            onPointerDownOutside={() => setOpen(false)}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
