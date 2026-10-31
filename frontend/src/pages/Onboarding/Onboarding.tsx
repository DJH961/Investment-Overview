import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Onboarding.scss";

export function Onboarding() {
  return (
    <div className="onboarding-page">
      <PageHeader title="Welcome" subtitle="Set up your portfolio." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
