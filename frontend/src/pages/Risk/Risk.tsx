import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Risk.scss";

export function Risk() {
  return (
    <div className="risk-page">
      <PageHeader title="Risk & analytics" subtitle="Volatility, drawdown and benchmarks." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
