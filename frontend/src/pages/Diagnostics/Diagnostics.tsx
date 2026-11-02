import clsx from "clsx";
import { Download } from "lucide-react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { useJobEvents } from "../../lib/queries/maintenance";
import { SUPPORT_BUNDLE_URL } from "../../lib/queries/manage";
import { usePersistentState } from "../../lib/usePersistentState";
import { HealthTab } from "./HealthTab";
import { LogsTab } from "./LogsTab";
import { MarketDataTab } from "./MarketDataTab";
import { RepairTab } from "./RepairTab";
import { SchedulerTab } from "./SchedulerTab";
import { SystemTab } from "./SystemTab";
import "./Diagnostics.scss";

export { RefreshCard } from "./HealthTab";

const TABS = [
  { id: "health", label: "Health", render: () => <HealthTab /> },
  { id: "repair", label: "Repair", render: () => <RepairTab /> },
  { id: "scheduler", label: "Scheduler", render: () => <SchedulerTab /> },
  { id: "market", label: "Market data", render: () => <MarketDataTab /> },
  { id: "logs", label: "Logs", render: () => <LogsTab /> },
  { id: "system", label: "System", render: () => <SystemTab /> },
] as const;
type TabId = (typeof TABS)[number]["id"];
const isTab = (v: unknown): v is TabId => TABS.some((t) => t.id === v);

/** Health & Repair (route `/diagnostics`). */
export function Diagnostics() {
  useJobEvents();
  const [params, setParams] = useSearchParams();
  const [remembered, setRemembered] = usePersistentState<TabId>("diagnostics.tab", "health", isTab);
  const fromUrl = params.get("tab");
  const tab: TabId = isTab(fromUrl) ? fromUrl : remembered;
  const select = (id: TabId) => {
    setRemembered(id);
    if (fromUrl) {
      params.delete("tab");
      setParams(params, { replace: true });
    }
  };

  return (
    <div className="diagnostics">
      <PageHeader
        title="Health & Repair"
        subtitle="Checks never change your data; Repair jobs do, and say so before they run."
        actions={
          <a className="diagnostics__download" href={SUPPORT_BUNDLE_URL} download>
            <Download aria-hidden size={16} /> Support bundle
          </a>
        }
      />
      <div className="diagnostics__tabs" role="tablist" aria-label="Health & Repair sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`diag-tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="diag-panel"
            className={clsx("diagnostics__tab-button", t.id === tab && "diagnostics__tab-button--active")}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="diag-panel" aria-labelledby={`diag-tab-${tab}`}>
        {TABS.find((t) => t.id === tab)?.render()}
      </div>
    </div>
  );
}
