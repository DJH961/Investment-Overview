import clsx from "clsx";
import { AlertCircle } from "lucide-react";
import { Button } from "../Button";
import "./ErrorState.scss";

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  message = "The data could not be loaded. Showing what we have, if anything.",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div className={clsx("error-state", className)} role="alert">
      <AlertCircle className="error-state__icon" aria-hidden />
      <div className="error-state__text">
        <p className="error-state__title">{title}</p>
        <p className="error-state__message">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
