import { Inbox } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./Transactions.scss";

export function Transactions() {
  return (
    <div className="transactions-page">
      <PageHeader title="Transactions" subtitle="Every buy, sell and cash movement." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Coming soon"
        description="This page is a placeholder and will be filled in by a later step of the v6 build."
      />
    </div>
  );
}
