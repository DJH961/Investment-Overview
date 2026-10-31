import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Projection.scss";

export function Projection() {
  return (
    <div className="projection-page">
      <PageHeader title="Projection & calculator" subtitle="What-if projections and the investment calculator." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
