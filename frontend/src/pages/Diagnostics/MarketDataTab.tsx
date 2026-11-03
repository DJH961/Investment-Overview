import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { useToast } from "../../components/Toast";
import { todayIn } from "../../lib/format";
import {
  useAnomalies,
  useDeleteFix,
  useInstrumentList,
  useJobCatalogue,
  useMarketSeries,
  useProbe,
  useSaveFix,
  type FixKind,
  type FixRow,
  type ProbeRequest,
} from "../../lib/queries/maintenance";
import { errorMessage } from "../../lib/queries/settings";
import { usePersistentState, writePersisted } from "../../lib/usePersistentState";
import { RunJob } from "./RunJob";

const KIND_LABEL: Record<FixKind, string> = { price: "Close price", fx: "FX rate (EUR→)", split: "Split ratio" };
const VALUE_LABEL: Record<FixKind, string> = { price: "Close (native currency)", fx: "Rate (1 EUR = …)", split: "Ratio (new shares per old)" };

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const isNumber = (s: string) => /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0;

function FixEditor({ initialInstrument }: { initialInstrument: number | null }) {
  const instruments = useInstrumentList();
  const { toast } = useToast();
  const [kind, setKind] = usePersistentState<FixKind>("diagnostics.market.kind", "price");
  const [instrument, setInstrument] = useState<string>(initialInstrument === null ? "" : String(initialInstrument));
  const [quote, setQuote] = useState("USD");
  const [start, setStart] = useState(daysAgo(30));
  const [end, setEnd] = useState(todayIn());
  const [date, setDate] = useState(todayIn());
  const [value, setValue] = useState("");
  const subject = kind === "fx" ? (quote.trim().toUpperCase() || null) : instrument || null;
  const series = useMarketSeries(kind, subject, start, end);
  const save = useSaveFix();
  const del = useDeleteFix();

  const columns: Column<FixRow>[] = [
    { key: "date", header: "Date", primary: true, cell: (r) => r.date, sortValue: (r) => r.date },
    { key: "value", header: kind === "split" ? "Ratio" : kind === "fx" ? "Rate" : "Close", align: "right", cell: (r) => r.value },
    {
      key: "source",
      header: "Source",
      cell: (r) => <span className={`market__source${r.source === "manual" ? " market__source--manual" : ""}`}>{r.source}</span>,
    },
    {
      key: "actions",
      header: "",
      cell: (r) =>
        r.source === "manual" || kind === "split" ? (
          <IconButton
            size="sm"
            label={`Delete ${kind} fix on ${r.date}`}
            icon={<Trash2 aria-hidden />}
            onClick={() =>
              subject &&
              del.mutate(
                { kind, subject, date: r.date },
                {
                  onSuccess: () => toast({ title: `Removed ${r.date}; the provider value comes back on the next fetch`, tone: "success" }),
                  onError: (e) => toast({ title: "Could not delete", description: errorMessage(e), tone: "error" }),
                },
              )
            }
          />
        ) : null,
    },
  ];

  return (
    <Card title="Manual fixes" subtitle="A manual value is never overwritten by a refresh. Valuations are rebuilt from that date.">
      <div className="market__controls">
        <SegmentedControl
          size="sm"
          ariaLabel="What to fix"
          options={(Object.keys(KIND_LABEL) as FixKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          value={kind}
          onChange={setKind}
        />
        {kind === "fx" ? (
          <Field label="Currency">
            {(c) => <Input {...c} maxLength={3} value={quote} onChange={(e) => setQuote(e.target.value.toUpperCase())} />}
          </Field>
        ) : (
          <Field label="Instrument">
            {(c) => (
              <Select
                id={c.id}
                placeholder={instruments.isPending ? "Loading…" : "Choose an instrument"}
                options={(instruments.data ?? []).map((i) => ({ value: String(i.id), label: i.name ? `${i.symbol} · ${i.name}` : i.symbol }))}
                value={instrument}
                onValueChange={setInstrument}
              />
            )}
          </Field>
        )}
        {kind !== "split" && (
          <>
            <Field label="From">{(c) => <Input {...c} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Field label="To">{(c) => <Input {...c} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
          </>
        )}
      </div>
      {subject &&
        (series.isError && !series.data ? (
          <ErrorState message={errorMessage(series.error)} onRetry={() => void series.refetch()} />
        ) : (
          <DataTable
            caption={`${KIND_LABEL[kind]} values`}
            columns={columns}
            rows={series.data ?? []}
            rowKey={(r) => r.date}
            loading={series.isPending}
            defaultSort={{ key: "date", direction: "desc" }}
            emptyMessage="No stored values in this range."
          />
        ))}
      {subject && (
        <form
          className="market__add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isNumber(value) || !date) return;
            save.mutate(
              { kind, subject, date, value: value.trim() },
              {
                onSuccess: () => {
                  setValue("");
                  toast({ title: `Saved manual ${kind} for ${date}`, tone: "success" });
                },
                onError: (err) => toast({ title: "Could not save", description: errorMessage(err), tone: "error" }),
              },
            );
          }}
        >
          <Field label="Date">{(c) => <Input {...c} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={VALUE_LABEL[kind]} error={value && !isNumber(value) ? "Enter a positive number" : undefined}>
            {(c) => <Input {...c} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(",", "."))} />}
          </Field>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!isNumber(value) || !date}>
            Save manual value
          </Button>
        </form>
      )}
    </Card>
  );
}

function ProbeCard() {
  const probe = useProbe();
  const [provider, setProvider] = useState<ProbeRequest["provider"]>("yfinance");
  const [symbol, setSymbol] = useState("");
  const r = probe.data;
  return (
    <Card title="Test a price service" subtitle="Asks the provider for one symbol now (does not store anything)." collapsibleId="market.probe">
      <form
        className="market__add"
        onSubmit={(e) => {
          e.preventDefault();
          if (symbol.trim()) probe.mutate({ provider, symbol: symbol.trim() });
        }}
      >
        <SegmentedControl
          size="sm"
          ariaLabel="Provider"
          options={[
            { value: "yfinance", label: "Yahoo" },
            { value: "tiingo", label: "Tiingo" },
          ]}
          value={provider}
          onChange={setProvider}
        />
        <Field label="Symbol">{(c) => <Input {...c} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />}</Field>
        <Button type="submit" loading={probe.isPending} disabled={!symbol.trim()}>
          Test
        </Button>
      </form>
      {probe.isError && <p className="repair__error" role="alert">{errorMessage(probe.error)}</p>}
      {r && (
        <p className="market__probe" aria-live="polite">
          <strong>{r.provider_label}</strong> · {r.symbol}: {r.verdict}
          {r.price ? ` · ${r.price}` : ""}
          {r.as_of ? ` (as of ${r.as_of})` : ""} · {r.duration_ms} ms. {r.detail}
        </p>
      )}
    </Card>
  );
}

export function MarketDataTab() {
  const anomalies = useAnomalies();
  const instruments = useInstrumentList();
  const jobs = useJobCatalogue();
  const redownload = jobs.data?.jobs.find((j) => j.id === "prices.redownload");
  const [editing, setEditing] = useState<number | null>(null);
  const name = (id: number) => {
    const i = instruments.data?.find((x) => x.id === id);
    return i ? (i.name ? `${i.symbol} · ${i.name}` : i.symbol) : `Instrument ${id}`;
  };
  const ids = anomalies.data?.instrument_ids ?? [];

  return (
    <div className="diagnostics__tab">
      <Card title={`Suspicious prices (${ids.length})`} subtitle="Instruments with a price spike or a gap worth checking." collapsibleId="market.anomalies">
        {anomalies.isError && !anomalies.data ? (
          <ErrorState onRetry={() => void anomalies.refetch()} />
        ) : ids.length === 0 ? (
          <p className="diagnostics__muted">{anomalies.isPending ? "Checking…" : "Nothing suspicious."}</p>
        ) : (
          <ul className="market__anomalies">
            {ids.map((id) => (
              <li key={id} className="market__anomaly">
                <span className="market__anomaly-name">{name(id)}</span>
                <Button size="sm" variant="ghost" onClick={() => {
                    writePersisted("diagnostics.market.kind", "price");
                    setEditing(id);
                  }}>
                  Inspect / fix
                </Button>
                {redownload && <RunJob job={redownload} params={{ instrument_id: id }} label="Re-download" />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <FixEditor key={editing ?? "none"} initialInstrument={editing} />
      <ProbeCard />
    </div>
  );
}
