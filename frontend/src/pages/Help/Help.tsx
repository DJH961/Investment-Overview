import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Help.scss";

export function Help() {
  return (
    <div className="help-page">
      <PageHeader title="Help" subtitle="How the numbers are built and how to use the app." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
