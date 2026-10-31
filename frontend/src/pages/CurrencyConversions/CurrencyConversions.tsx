import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./CurrencyConversions.scss";

export function CurrencyConversions() {
  return (
    <div className="currency-conversions-page">
      <PageHeader title="Currency conversions" subtitle="EUR and USD exchanges." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
