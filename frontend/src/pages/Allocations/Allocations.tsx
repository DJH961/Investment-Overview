import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Allocations.scss";

export function Allocations() {
  return (
    <div className="allocations-page">
      <PageHeader title="Allocations" subtitle="Target weights and the rebalance plan." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
