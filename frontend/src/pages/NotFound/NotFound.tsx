import { Inbox } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import "./NotFound.scss";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="not-found-page">
      <PageHeader title="Page not found" subtitle="That address does not exist." />
      <EmptyState
        icon={<Inbox aria-hidden />}
        title="Nothing here"
        description="Check the address, or pick a page from the menu."
        action={
          <Button variant="primary" onClick={() => navigate("/overview")}>
            Back to Overview
          </Button>
        }
      />
    </div>
  );
}
