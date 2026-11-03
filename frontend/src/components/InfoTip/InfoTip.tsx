import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "../Tooltip";
import "./InfoTip.scss";

export interface InfoTipProps {
  /** What the figure means, in plain language. */
  content: ReactNode;
  /** Names the figure for screen readers: "About <label>". */
  label: string;
}

/** A small (i) button that explains a figure on hover, focus or tap. */
export function InfoTip({ content, label }: InfoTipProps) {
  return (
    <Tooltip content={content}>
      <button type="button" className="info-tip" aria-label={`About ${label}`}>
        <Info aria-hidden className="info-tip__icon" />
      </button>
    </Tooltip>
  );
}
