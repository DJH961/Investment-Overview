import { Check, Contrast, Landmark, Pin } from "lucide-react";
import { Chip } from "../../components/Chip";
import type { DepositStatus } from "../../lib/queries/manage";
import { depositStatusLook } from "./matching";

const ICONS = {
  check: <Check aria-hidden />,
  half: <Contrast aria-hidden />,
  ecb: <Landmark aria-hidden />,
  pin: <Pin aria-hidden />,
};

/** Matching status: always an icon and a word, never colour alone. */
export function StatusChip({ status, pinned }: { status: DepositStatus; pinned: boolean }) {
  const look = depositStatusLook(status, pinned);
  return (
    <Chip size="sm" tone={look.tone} icon={ICONS[look.icon]}>
      {look.label}
    </Chip>
  );
}
