"use client";

import * as React from "react";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";

type ToastTone = "default" | "success" | "warning" | "danger";

interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const TONE_CLASS: Record<ToastTone, string> = {
  default: "",
  success: "border-l-[3px] border-l-success",
  warning: "border-l-[3px] border-l-warning",
  danger: "border-l-[3px] border-l-danger",
};

export function ToastProviderContext({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<
    Array<ToastOptions & { id: number }>
  >([]);
  const counter = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = ++counter.current;
      setItems((prev) => [...prev.slice(-4), { ...options, id }]);
    },
    [],
  );

  const value = React.useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) =>
        toast({ title, description, tone: "success" }),
      error: (title, description) =>
        toast({ title, description, tone: "danger", duration: 8000 }),
      warning: (title, description) =>
        toast({ title, description, tone: "warning" }),
      info: (title, description) => toast({ title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      <ToastProvider swipeDirection="right">
        {children}
        {items.map((item) => (
          <Toast
            key={item.id}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
            duration={item.duration ?? 5000}
            className={TONE_CLASS[item.tone ?? "default"]}
          >
            <div className="min-w-0 flex-1">
              <ToastTitle>{item.title}</ToastTitle>
              {item.description && (
                <ToastDescription>{item.description}</ToastDescription>
              )}
            </div>
            <ToastClose />
          </Toast>
        ))}
        <ToastViewport />
      </ToastProvider>
    </ToastContext.Provider>
  );
}

/**
 * Toast notifications.
 *
 * Call `useToast()` from any client component. `toast.success` / `toast.error`
 * cover the common cases; `toast.toast` accepts a tone and duration.
 */
export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProviderContext>");
  }
  return context;
}
