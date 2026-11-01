import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import "./Menu.scss";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
}

export interface MenuProps {
  /** The trigger element (a Button or IconButton); rendered via asChild. */
  trigger: ReactNode;
  items: MenuItem[];
  /** Optional non-interactive heading (for example the signed-in user). */
  heading?: ReactNode;
  align?: "start" | "center" | "end";
}

export function Menu({ trigger, items, heading, align = "end" }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu__content" align={align} sideOffset={6}>
          {heading && <DropdownMenu.Label className="menu__heading">{heading}</DropdownMenu.Label>}
          {items.map((item) => (
            <div key={item.label}>
              {item.separatorBefore && <DropdownMenu.Separator className="menu__separator" />}
              <DropdownMenu.Item
                className={clsx("menu__item", item.danger && "menu__item--danger")}
                onSelect={item.onSelect}
              >
                {item.icon && <span className="menu__icon">{item.icon}</span>}
                {item.label}
              </DropdownMenu.Item>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
