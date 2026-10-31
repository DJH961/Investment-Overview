import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Holdings.scss";

export function Holdings() {
  return (
    <div className="holdings-page">
      <PageHeader title="Holdings" subtitle="Positions, weights and unrealised results." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
