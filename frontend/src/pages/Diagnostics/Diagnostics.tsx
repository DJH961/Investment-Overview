import { Download } from "lucide-react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
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
      {/* The shared segmented control: arrow keys and the finger-sized phone targets come with it.
          On a very narrow phone the six sections may scroll sideways rather than squash. */}
      <div className="diagnostics__tabs" data-scrollable>
        <SegmentedControl
          className="diagnostics__segmented"
          ariaLabel="Health & Repair sections"
          options={TABS.map((t) => ({ value: t.id, label: t.label }))}
          value={tab}
          onChange={select}
        />
      </div>
      <section aria-label={TABS.find((t) => t.id === tab)?.label}>
        {TABS.find((t) => t.id === tab)?.render()}
      </section>
    </div>
  );
}
