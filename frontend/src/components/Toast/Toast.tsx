import clsx from "clsx";
import { Toast as RadixToast } from "radix-ui";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import "./Toast.scss";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: "neutral" | "success" | "error";
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastApi {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((options: ToastOptions) => {
    setItems((prev) => [...prev, { ...options, id: nextId++ }]);
  }, []);
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((item) => (
          <RadixToast.Root
            key={item.id}
            className={clsx("toast", `toast--${item.tone ?? "neutral"}`)}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((t) => t.id !== item.id));
            }}
          >
            <RadixToast.Title className="toast__title">{item.title}</RadixToast.Title>
            {item.description && (
              <RadixToast.Description className="toast__description">{item.description}</RadixToast.Description>
            )}
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="toast__viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
