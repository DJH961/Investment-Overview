import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Settings.scss";

export function Settings() {
  return (
    <div className="settings-page">
      <PageHeader title="Settings" subtitle="Currency, theme, timezone, passkeys and backup." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
