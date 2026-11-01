import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { IconButton } from "../IconButton";
import "./Dialog.scss";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer row, typically Buttons. */
  footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog__overlay" />
        <RadixDialog.Content className="dialog__content" {...(description ? {} : { "aria-describedby": undefined })}>
          <header className="dialog__header">
            <div className="dialog__heading">
              <RadixDialog.Title className="dialog__title">{title}</RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="dialog__description">{description}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <IconButton label="Close" size="sm" icon={<X aria-hidden />} />
            </RadixDialog.Close>
          </header>
          {children && <div className="dialog__body">{children}</div>}
          {footer && <footer className="dialog__footer">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
