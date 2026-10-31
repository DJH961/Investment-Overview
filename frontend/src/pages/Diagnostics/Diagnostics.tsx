import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Diagnostics.scss";

export function Diagnostics() {
  return (
    <div className="diagnostics-page">
      <PageHeader title="Data health" subtitle="Price and FX coverage, freshness and warnings." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
