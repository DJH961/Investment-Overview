import { Moon, Plus, Settings as SettingsIcon, Sun, SunMoon, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { AllocationBar } from "../../components/AllocationBar";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chart } from "../../components/Chart";
import { DataTable, type Column } from "../../components/DataTable";
import { DeltaBadge } from "../../components/DeltaBadge";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Freshness } from "../../components/Freshness";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { KpiTile } from "../../components/KpiTile";
import { Menu } from "../../components/Menu";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { Sparkline } from "../../components/Sparkline";
import { useToast } from "../../components/Toast";
import { Tooltip } from "../../components/Tooltip";
import { Treemap } from "../../components/Treemap";
import { formatDate, formatMoney, formatTime } from "../../lib/format";
import { usePrefs, type ThemeChoice } from "../../lib/prefs";
import { DEMO_HOLDINGS, DEMO_RANGES, demoSeries, type DemoHolding, type DemoRange } from "./demoData";
import "./Styleguide.scss";

const THEME_ICON: Record<ThemeChoice, ReactNode> = {
  system: <SunMoon aria-hidden size={16} />,
  light: <Sun aria-hidden size={16} />,
  dark: <Moon aria-hidden size={16} />,
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="styleguide__section" id={id} aria-labelledby={`${id}-h`}>
      <h2 className="styleguide__heading" id={`${id}-h`}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const SECTIONS = [
  ["charts", "Charts"],
  ["tiles", "KPI tiles"],
  ["numbers", "Numbers"],
  ["buttons", "Buttons"],
  ["forms", "Forms"],
  ["overlays", "Overlays"],
  ["feedback", "Feedback"],
  ["table", "Table"],
] as const;

export function Styleguide() {
  const { theme, setTheme, currency, setCurrency } = usePrefs();
  const { toast } = useToast();
  const [range, setRange] = useState<DemoRange>("1M");
  const [seg, setSeg] = useState("eur");
  const [select, setSelect] = useState("acc");
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);

  const series = useMemo(() => demoSeries(range), [range]);
  const sparkValues = useMemo(() => demoSeries("1M")[0].points.map((p) => p.v), []);
  const total = DEMO_HOLDINGS.reduce((a, h) => a + h.value, 0);

  const eur = (v: number) => formatMoney(v, "EUR", { compact: true });
  const timeFmt = (t: number) => (range === "1D" ? formatTime(new Date(t)) : formatDate(new Date(t), "short"));

  const columns: Column<DemoHolding>[] = [
    {
      key: "name",
      header: "Instrument",
      primary: true,
      cell: (h) => h.name,
      sortValue: (h) => h.name,
    },
    { key: "isin", header: "ISIN", cell: (h) => h.isin },
    {
      key: "value",
      header: "Value",
      align: "right",
      cell: (h) => <Money amount={h.value} currency="EUR" />,
      sortValue: (h) => h.value,
    },
    {
      key: "ret",
      header: "Return",
      align: "right",
      cell: (h) => <Percent ratio={h.returnRatio} signed colored />,
      sortValue: (h) => h.returnRatio,
    },
    {
      key: "w",
      header: "Weight",
      align: "right",
      cell: (h) => <Percent ratio={h.weight} />,
      sortValue: (h) => h.weight,
    },
  ];

  return (
    <div className="styleguide">
      <PageHeader
        title="Styleguide"
        subtitle="Every component of the kit with demo data. Use it to review the look in both themes."
        actions={
          <div className="styleguide__toggles">
            <SegmentedControl<ThemeChoice>
              ariaLabel="Theme"
              size="sm"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ]}
            />
            <SegmentedControl
              ariaLabel="Reporting currency"
              size="sm"
              value={currency}
              onChange={(c) => setCurrency(c as "EUR" | "USD")}
              options={[
                { value: "EUR", label: "EUR" },
                { value: "USD", label: "USD" },
              ]}
            />
            <span className="styleguide__theme-icon">{THEME_ICON[theme]}</span>
          </div>
        }
      />

      <nav className="styleguide__toc" aria-label="Sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} className="styleguide__toc-link" href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <Section id="charts" title="Charts">
        <Card
          title="Portfolio value"
          subtitle="Line and area with benchmark, gap in the 1M range, crosshair on hover or touch"
        >
          <Chart
            series={series}
            ranges={[...DEMO_RANGES]}
            range={range}
            onRangeChange={(r) => setRange(r as DemoRange)}
            valueFormat={eur}
            timeFormat={timeFmt}
            height={300}
            ariaLabel="Demo portfolio value"
          />
        </Card>
        <div className="styleguide__grid">
          <Card title="Loading">
            <Chart series={[]} loading valueFormat={eur} timeFormat={timeFmt} height={160} />
          </Card>
          <Card title="Empty">
            <Chart series={[]} valueFormat={eur} timeFormat={timeFmt} height={160} emptyMessage="No history yet." />
          </Card>
        </div>
        <Card title="Allocation" subtitle="Actual weights with target markers and drift">
          <AllocationBar
            slices={DEMO_HOLDINGS.map((h) => ({
              id: h.id,
              label: h.name,
              actual: h.weight,
              target: h.target,
            }))}
          />
        </Card>
        <Card title="Treemap" subtitle="Area by value, tint by return sign">
          <Treemap
            height={300}
            valueFormat={(v) => formatMoney(v, "EUR", { compact: true })}
            items={DEMO_HOLDINGS.map((h) => ({
              id: h.id,
              label: h.name,
              value: h.value,
              tone: h.returnRatio > 0 ? "pos" : h.returnRatio < 0 ? "neg" : "neutral",
            }))}
          />
        </Card>
      </Section>

      <Section id="tiles" title="KPI tiles">
        <div className="styleguide__grid styleguide__grid--tiles">
          <KpiTile
            label="Total value"
            value={<Money amount={total} currency="EUR" />}
            delta={<DeltaBadge value={0.0132} />}
            hint="today"
            sparkline={<Sparkline values={sparkValues} width={160} />}
          />
          <KpiTile
            label="Total return (XIRR)"
            value={<Percent ratio={0.0874} signed />}
            delta={<DeltaBadge value={1840} format="money" currency="EUR" />}
            hint="since start"
            sparkline={<Sparkline values={sparkValues} tone="primary" width={160} />}
          />
          <KpiTile
            label="Drawdown"
            value={<Percent ratio={-0.042} />}
            delta={<DeltaBadge value={-0.004} />}
            sparkline={<Sparkline values={[...sparkValues].reverse()} width={160} />}
          />
          <KpiTile label="Loading tile" value="" loading />
        </div>
      </Section>

      <Section id="numbers" title="Numbers">
        <Card>
          <div className="styleguide__row">
            <Money amount={251_340.5} currency="EUR" />
            <Money amount={251_340.5} currency="USD" />
            <Money amount={251_340.5} currency="EUR" compact />
            <Money amount={1840} currency="EUR" signed colored />
            <Money amount={-920.4} currency="EUR" signed colored />
            <Percent ratio={0.0874} signed colored />
            <Percent ratio={-0.0211} signed colored />
            <DeltaBadge value={0.0132} />
            <DeltaBadge value={-0.0087} />
            <DeltaBadge value={420} format="money" currency="USD" />
          </div>
        </Card>
      </Section>

      <Section id="buttons" title="Buttons">
        <Card>
          <div className="styleguide__row">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" leftIcon={<Trash2 aria-hidden size={16} />}>
              Delete
            </Button>
            <Button loading>Saving</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
          </div>
          <div className="styleguide__row">
            <IconButton label="Add" icon={<Plus aria-hidden size={18} />} />
            <IconButton label="Settings (active)" icon={<SettingsIcon aria-hidden size={18} />} active />
            <Menu
              heading="Account"
              trigger={<Button variant="secondary">Menu</Button>}
              items={[
                {
                  label: "Settings",
                  icon: <SettingsIcon aria-hidden size={16} />,
                  onSelect: () => undefined,
                },
                {
                  label: "Delete",
                  icon: <Trash2 aria-hidden size={16} />,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => undefined,
                },
              ]}
            />
            <Tooltip content="A short explanation">
              <Button variant="ghost">Hover me</Button>
            </Tooltip>
          </div>
        </Card>
      </Section>

      <Section id="forms" title="Forms">
        <Card>
          <div className="styleguide__grid">
            <Field label="Name" hint="Shown in the sidebar">
              <Input placeholder="Jane Doe" />
            </Field>
            <Field label="Amount" error="Must be a positive number">
              {(p) => <Input {...p} defaultValue="-5" />}
            </Field>
            <Field label="Account type">
              {(p) => (
                <Select
                  id={p.id}
                  value={select}
                  onValueChange={setSelect}
                  options={[
                    { value: "acc", label: "Accumulating" },
                    {
                      value: "dist",
                      label: "Distributing",
                    },
                  ]}
                />
              )}
            </Field>
            <Field label="Segmented control">
              <SegmentedControl
                ariaLabel="Currency"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: "eur", label: "EUR" },
                  { value: "usd", label: "USD" },
                  { value: "both", label: "Both" },
                ]}
              />
            </Field>
          </div>
        </Card>
      </Section>

      <Section id="overlays" title="Overlays">
        <Card>
          <div className="styleguide__row">
            <Button variant="secondary" onClick={() => setDialog(true)}>
              Open dialog
            </Button>
            <Button variant="secondary" onClick={() => setSheet(true)}>
              Open sheet
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast({
                  title: "Saved",
                  description: "Your changes are stored.",
                })
              }
            >
              Show toast
            </Button>
          </div>
        </Card>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Delete transaction?"
          description="This cannot be undone."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => setDialog(false)}>
                Delete
              </Button>
            </>
          }
        >
          <p>Buy 12 x VWCE on 2026-03-04.</p>
        </Dialog>
        <Sheet open={sheet} onOpenChange={setSheet} title="Filters">
          <p>Sheet content goes here.</p>
        </Sheet>
      </Section>

      <Section id="feedback" title="Feedback">
        <div className="styleguide__grid">
          <Card title="Freshness">
            <div className="styleguide__row">
              <Freshness status="live" label="Live" />
              <Freshness status="closed" label="Market closed" />
              <Freshness status="stale" label="Stale 2 d" />
              <Freshness status="loading" label="Loading" />
            </div>
          </Card>
          <Card title="Skeleton">
            <div className="styleguide__stack">
              <Skeleton height="1.5rem" width="50%" />
              <Skeleton height="1rem" />
              <Skeleton circle width="40px" height="40px" />
            </div>
          </Card>
          <Card title="Empty state">
            <EmptyState
              title="No transactions yet"
              description="Import a broker file to get started."
              action={<Button>Import</Button>}
            />
          </Card>
          <Card title="Error state">
            <ErrorState
              title="Could not load"
              message="The server did not answer."
              onRetry={() => toast({ title: "Retrying" })}
            />
          </Card>
        </div>
      </Section>

      <Section id="table" title="Table">
        <Card flush>
          <DataTable
            caption="Holdings"
            columns={columns}
            rows={DEMO_HOLDINGS}
            rowKey={(h) => h.id}
            defaultSort={{ key: "value", direction: "desc" }}
          />
        </Card>
        <Card flush>
          <DataTable caption="Loading" columns={columns} rows={[]} rowKey={(h) => h.id} loading />
        </Card>
        <Card flush>
          <DataTable caption="Empty" columns={columns} rows={[]} rowKey={(h) => h.id} emptyMessage="Nothing to show." />
        </Card>
      </Section>
    </div>
  );
}
