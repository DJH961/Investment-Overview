import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import "./Sheet.scss";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children?: ReactNode;
}

/** Mobile bottom sheet (also fine on larger screens, where it is centred and capped in width). */
export function Sheet({ open, onOpenChange, title, children }: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="sheet__overlay" />
        <RadixDialog.Content className="sheet__content" aria-describedby={undefined}>
          <span className="sheet__handle" aria-hidden />
          <RadixDialog.Title className="sheet__title">{title}</RadixDialog.Title>
          <div className="sheet__body">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
