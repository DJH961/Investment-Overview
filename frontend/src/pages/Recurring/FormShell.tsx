import type { ReactNode } from "react";
import { Dialog } from "../../components/Dialog";
import { Sheet } from "../../components/Sheet";
import { useIsPhone } from "../../lib/useMediaQuery";

/**
 * The frame of every Recurring form: a bottom sheet with a sticky footer on phones, a dialog
 * near the top of the viewport on larger screens (scrolling body, footer always visible).
 */
export function FormShell({
  open,
  onClose,
  title,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  const phone = useIsPhone();
  if (phone) {
    return (
      <Sheet open={open} onOpenChange={(o) => !o && onClose()} title={title}>
        {children}
        <div className="recurring-page__setup-footer">{footer}</div>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} footer={footer} top>
      {children}
    </Dialog>
  );
}
