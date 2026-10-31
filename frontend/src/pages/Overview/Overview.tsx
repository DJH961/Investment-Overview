import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Overview.scss";

export function Overview() {
  return (
    <div className="overview-page">
      <PageHeader title="Overview" subtitle="Value, returns and currency effect at a glance." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
