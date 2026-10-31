import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Activity.scss";

export function Activity() {
  return (
    <div className="activity-page">
      <PageHeader title="Activity" subtitle="Deposits and dividends." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
