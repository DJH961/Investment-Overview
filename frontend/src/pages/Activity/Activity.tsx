import { Inbox } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatNumber } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import {
  type DepositFilters,
  type DepositKindFilter,
  type DepositRowDto,
  type DividendRowDto,
  useDeposits,
  useDividends,
} from "../../lib/queries/activity";
import { useAccounts } from "../../lib/queries/accounts";
import { toNum } from "../../lib/queries/portfolio";
import { useShellStatus } from "../../lib/shell";
import { usePersistentState, type Validator } from "../../lib/usePersistentState";
import { Maybe } from "../Periods/Maybe";
import { useIsPhone } from "../../lib/useMediaQuery";
import { PhoneActivityList, type PhoneActivityItem } from "./PhoneActivity";
import "./Activity.scss";

type Tab = "contributions" | "dividends";
const ALL = "__all__";

const TABS: Tab[] = ["contributions", "dividends"];
const KINDS: { value: string; label: string }[] = [
  { value: ALL, label: "All kinds" },
  { value: "deposit", label: "Deposits" },
  { value: "withdrawal", label: "Withdrawals" },
  { value: "transfer", label: "Transfers" },
];
const oneOf =
  (allowed: string[]): Validator<string> =>
  (v): v is string =>
    typeof v === "string" && allowed.includes(v);

const KIND_LABEL: Record<string, string> = {
  cash: "Cash",
  reinvest: "Reinvested",
  interest: "Interest",
};

/** Empty-state way out: the Import page. */
function ImportButton() {
  const navigate = useNavigate();
  return (
    <Button variant="primary" onClick={() => navigate("/import")}>
      Import a broker file
    </Button>
  );
}

export function Activity() {
  const { currency } = usePrefs();
  const phone = useIsPhone();
  const other = currency === "EUR" ? "USD" : "EUR";
  const [tab, setTab] = usePersistentState<Tab>("activity.tab", "contributions", oneOf(TABS) as Validator<Tab>);
  const [accountPref, setAccount] = usePersistentState<string>("activity.account", ALL);
  const [kind, setKind] = usePersistentState<string>("activity.kind", ALL, oneOf(KINDS.map((k) => k.value)));
  const [year, setYear] = usePersistentState<string>("activity.year", ALL);

  const accounts = useAccounts();
  const accountIds = useMemo(() => new Set((accounts.data ?? []).map((a) => String(a.id))), [accounts.data]);
  // A remembered account that was deleted falls back to "all".
  const account = accountPref === ALL || !accounts.data || accountIds.has(accountPref) ? accountPref : ALL;

  const filters: DepositFilters = {
    accountId: account === ALL ? null : Number(account),
    kind: kind === ALL ? null : (kind as DepositKindFilter),
    year: year === ALL ? null : Number(year),
  };
  const deposits = useDeposits(currency, filters);
  const dividends = useDividends(currency, tab === "dividends");
  const active = tab === "contributions" ? deposits : dividends;
  const { refetch: activeRefetch } = active;
  const refetch = useCallback(() => void activeRefetch(), [activeRefetch]);
  useShellStatus(
    active.isError ? "stale" : active.isPending ? "loading" : "closed",
    active.data ? `As of ${formatDate(active.data.as_of)}` : "Loading",
    refetch,
    active.isFetching,
  );

  /** Amount with the same cashflow in the other currency as a muted second line. */
  const money = (v: string | null | undefined, o?: string | null) => (
    <span className="activity-page__amount">
      <Maybe present={toNum(v) !== null} ccy={currency}>
        <Money amount={toNum(v)} currency={currency} />
      </Maybe>
      {toNum(o) !== null && (
        <span className="activity-page__second">
          <Money amount={toNum(o)} currency={other} />
        </span>
      )}
    </span>
  );

  const paidFrom = (r: DepositRowDto) => {
    if (!r.rate_source) return "";
    const rate = toNum(r.effective_rate);
    const batches = r.conversion_batches ?? [];
    const from = batches.map((b) => formatDate(b.date)).join(", ");
    const ecb = r.rate_source === "conversions" ? "" : r.rate_source === "ecb" ? "ECB rate" : "rest at ECB rate";
    const head = [from && `Conversion ${from}`, ecb].filter(Boolean).join("; ");
    return rate === null ? head : `${head} (${formatNumber(rate, 4)} USD/EUR)`;
  };

  const depositColumns: Column<DepositRowDto>[] = [
    {
      key: "date",
      header: "Date",
      primary: true,
      sortValue: (r) => r.date,
      cell: (r) => formatDate(r.date),
    },
    {
      key: "kind",
      header: "Kind",
      phone: "inline",
      sortValue: (r) => r.kind,
      cell: (r) => <span className="activity-page__kind">{r.kind.replace("_", " ")}</span>,
    },
    {
      key: "account",
      header: "Account",
      phone: "sub",
      sortValue: (r) => r.account,
      cell: (r) => r.account,
    },
    {
      key: "description",
      header: "Description",
      phone: "hide",
      cell: (r) => <span className="activity-page__desc">{r.description}</span>,
    },
    {
      key: "native",
      header: "Native",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.amount_native),
      cell: (r) => <Money amount={toNum(r.amount_native)} currency={r.currency} />,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      phone: "headline",
      sortValue: (r) => toNum(r.amount),
      cell: (r) => money(r.amount, r.amount_other),
    },
    {
      key: "paid",
      header: "Paid from",
      phone: "hide",
      cell: (r) => (r.rate_source ? <span className="activity-page__paid">{paidFrom(r)}</span> : null),
    },
  ];

  const rowKey = (r: DepositRowDto) => String(r.id ?? `${r.date}-${r.account}-${r.amount_native}`);

  const contributions = (() => {
    const data = deposits.data;
    if (!data) return null;
    const rowsByYear = new Map<number, DepositRowDto[]>();
    for (const r of data.rows) {
      const y = Number(r.date.slice(0, 4));
      rowsByYear.set(y, [...(rowsByYear.get(y) ?? []), r]);
    }
    const yearOptions = [
      { value: ALL, label: "All years" },
      ...[...new Set([...data.years, ...(year === ALL ? [] : [Number(year)])])]
        .sort((a, b) => b - a)
        .map((y) => ({ value: String(y), label: String(y) })),
    ];
    const s = data.summary as typeof data.summary & {
      cashed_out?: string | null;
      cashed_out_eur?: string | null;
    };
    const so = data.summary_other as typeof data.summary_other & {
      cashed_out?: string | null;
      cashed_out_eur?: string | null;
    };
    const cashedOutEur = toNum(
      (data as typeof data & { cashed_out_eur?: string | null }).cashed_out_eur ?? s.cashed_out_eur,
    );
    const cashedOut = toNum(s.cashed_out);
    const showCashedOut = (cashedOutEur !== null && cashedOutEur > 0) || (cashedOut !== null && cashedOut > 0);
    const otherHint = (v: string | null | undefined) =>
      toNum(v) === null ? undefined : <Money amount={toNum(v)} currency={other} />;
    const cell = (label: string, v: string | null | undefined, o: string | null | undefined, node?: ReactNode) => (
      <div className="activity-phone__cell">
        <dt className="activity-phone__label">{label}</dt>
        <dd className="activity-phone__cell-main">{node ?? <Money amount={toNum(v)} currency={currency} />}</dd>
        {toNum(o) !== null && (
          <dd className="activity-phone__cell-second">
            <Money amount={toNum(o)} currency={other} />
          </dd>
        )}
      </div>
    );
    const items: PhoneActivityItem[] = [...data.rows]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((r) => ({
        key: rowKey(r),
        date: r.date,
        title: formatDate(r.date),
        sub: r.account,
        amount: r.amount,
        amountOther: r.amount_other,
        pill: r.kind.replace("_", " "),
        pillSub: r.rate_source ? (r.rate_source === "ecb" ? "ECB rate" : "Converted") : undefined,
        details: [
          ...(r.description ? [{ label: "Description", value: r.description }] : []),
          {
            label: "Native",
            value: <Money amount={toNum(r.amount_native)} currency={r.currency} />,
          },
          ...(r.rate_source ? [{ label: "Paid from", value: paidFrom(r) }] : []),
        ],
      }));
    return (
      <div className="activity-page__stack">
        {phone ? (
          <dl className="activity-phone__summary">
            {cell("Total", s.total_contrib, so.total_contrib)}
            {cell("This year", s.ytd_contrib, so.ytd_contrib)}
            {cell("This month", s.mtd_contrib, so.mtd_contrib)}
            {showCashedOut &&
              cell(
                "Cashed out",
                s.cashed_out,
                so.cashed_out,
                cashedOut !== null ? undefined : <Money amount={cashedOutEur} currency="EUR" />,
              )}
          </dl>
        ) : (
          <div className="activity-page__kpis">
            <KpiTile label="Total" value={money(s.total_contrib)} secondary={otherHint(so.total_contrib)} />
            <KpiTile label="This year" value={money(s.ytd_contrib)} secondary={otherHint(so.ytd_contrib)} />
            <KpiTile label="This month" value={money(s.mtd_contrib)} secondary={otherHint(so.mtd_contrib)} />
            {showCashedOut && (
              <KpiTile
                label="Cashed out"
                value={cashedOut !== null ? money(s.cashed_out) : <Money amount={cashedOutEur} currency="EUR" />}
                secondary={cashedOut !== null ? otherHint(so.cashed_out) : undefined}
              />
            )}
          </div>
        )}
        <div className={phone ? "activity-phone__filters" : "activity-page__filters"}>
          <Select
            ariaLabel="Account"
            value={account}
            onValueChange={setAccount}
            options={[
              { value: ALL, label: phone ? "Accounts" : "All accounts" },
              ...(accounts.data ?? []).map((a) => ({
                value: String(a.id),
                label: a.account_label,
              })),
            ]}
          />
          <Select ariaLabel="Kind" value={kind} onValueChange={setKind} options={KINDS} />
          <Select ariaLabel="Year" value={year} onValueChange={setYear} options={yearOptions} />
        </div>
        {data.by_year.length === 0 ? (
          <EmptyState
            icon={<Inbox aria-hidden />}
            title={data.years.length === 0 ? "No contributions yet" : "No contributions match"}
            description={
              data.years.length === 0 ? "Import a broker file to see your deposits here." : "Try different filters."
            }
            action={data.years.length === 0 ? <ImportButton /> : undefined}
          />
        ) : phone ? (
          <PhoneActivityList
            items={items}
            currency={currency}
            totalLabel="Net"
            groupBy="year"
            totals={Object.fromEntries(
              data.by_year.map((y) => [String(y.year), { amount: y.total, other: y.total_other }]),
            )}
          />
        ) : (
          data.by_year.map((y, i) => (
            <Card
              key={y.year}
              title={String(y.year)}
              subtitle={
                <>
                  {y.count} flow{y.count === 1 ? "" : "s"} · net <Money amount={toNum(y.total)} currency={currency} />
                  {" · "}
                  <Money amount={toNum(y.total_other)} currency={other} />
                </>
              }
              collapsibleId={`activity.year.${y.year}`}
              defaultOpen={i === 0}
              flush
            >
              <DataTable
                caption={`Contributions ${y.year}`}
                columns={depositColumns}
                rows={rowsByYear.get(y.year) ?? []}
                rowKey={rowKey}
                defaultSort={{ key: "date", direction: "desc" }}
              />
            </Card>
          ))
        )}
      </div>
    );
  })();

  const dividendsView = (() => {
    const d = dividends.data;
    if (!d) return null;
    if (d.rows.length === 0) return <EmptyState icon={<Inbox aria-hidden />} title="No dividends yet" />;
    const hint = (v: string) => <Money amount={toNum(v)} currency={other} />;
    const holdingColumns: Column<(typeof d.by_holding)[number]>[] = [
      {
        key: "symbol",
        header: "Holding",
        primary: true,
        sortValue: (r) => r.symbol,
        cell: (r) => <strong>{r.symbol}</strong>,
      },
      {
        key: "life",
        header: "Lifetime",
        align: "right",
        phone: "headline",
        sortValue: (r) => toNum(r.lifetime),
        cell: (r) => money(r.lifetime, r.lifetime_other),
      },
      {
        key: "ttm",
        header: "Last 12 months",
        align: "right",
        sortValue: (r) => toNum(r.ttm),
        cell: (r) => money(r.ttm, r.ttm_other),
      },
      {
        key: "count",
        header: "Payments",
        align: "right",
        sortValue: (r) => r.count,
        cell: (r) => r.count,
      },
      {
        key: "last",
        header: "Last paid",
        phone: "hide",
        sortValue: (r) => r.last_date,
        cell: (r) => formatDate(r.last_date),
      },
    ];
    const yearColumns: Column<(typeof d.by_year)[number]>[] = [
      {
        key: "year",
        header: "Year",
        primary: true,
        sortValue: (r) => r.year,
        cell: (r) => r.year,
      },
      {
        key: "div",
        header: "Dividends",
        align: "right",
        phone: "headline",
        sortValue: (r) => toNum(r.dividends),
        cell: (r) => money(r.dividends, r.dividends_other),
      },
      {
        key: "int",
        header: "Interest",
        align: "right",
        cell: (r) => money(r.interest, r.interest_other),
      },
    ];
    const paymentColumns: Column<DividendRowDto>[] = [
      {
        key: "date",
        header: "Date",
        primary: true,
        sortValue: (r) => r.date,
        cell: (r) => formatDate(r.date),
      },
      {
        key: "symbol",
        header: "Holding",
        phone: "sub",
        sortValue: (r) => r.symbol,
        cell: (r) => r.symbol || "–",
      },
      {
        key: "kind",
        header: "Type",
        cell: (r) => KIND_LABEL[r.kind] ?? r.kind,
      },
      {
        key: "account",
        header: "Account",
        phone: "hide",
        cell: (r) => r.account,
      },
      {
        key: "native",
        header: "Native",
        align: "right",
        phone: "hide",
        sortValue: (r) => toNum(r.amount_native),
        cell: (r) => <Money amount={toNum(r.amount_native)} currency={r.currency} />,
      },
      {
        key: "amount",
        header: "Amount",
        align: "right",
        phone: "headline",
        sortValue: (r) => toNum(r.amount),
        cell: (r) => money(r.amount, r.amount_other),
      },
    ];
    return (
      <div className="activity-page__stack">
        <div className="activity-page__kpis">
          <KpiTile
            label="Lifetime dividends"
            value={money(d.lifetime_total)}
            secondary={hint(d.lifetime_total_other)}
          />
          <KpiTile label="Last 12 months" value={money(d.ttm_total)} secondary={hint(d.ttm_total_other)} />
          <KpiTile
            label="Yield (TTM)"
            value={<Percent ratio={toNum(d.yield_ttm)} />}
            hint={d.yield_lifetime ? <Percent ratio={toNum(d.yield_lifetime)} /> : undefined}
          />
        </div>
        <Card title="By holding" collapsibleId="activity.divs.holding" flush>
          <DataTable
            caption="Dividends by holding"
            columns={holdingColumns}
            rows={d.by_holding}
            rowKey={(r) => r.symbol}
            defaultSort={{ key: "life", direction: "desc" }}
          />
        </Card>
        <Card title="By year" collapsibleId="activity.divs.year" flush>
          <DataTable
            caption="Dividends and interest by year"
            columns={yearColumns}
            rows={d.by_year}
            rowKey={(r) => String(r.year)}
            defaultSort={{ key: "year", direction: "desc" }}
          />
        </Card>
        {phone && (
          <PhoneActivityList
            totalLabel="Received"
            currency={currency}
            items={[...d.rows]
              .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
              .map((r) => ({
                key: String(r.id ?? `${r.date}-${r.symbol}-${r.kind}`),
                date: r.date,
                title: r.symbol || "–",
                sub: formatDate(r.date),
                amount: r.amount,
                amountOther: r.amount_other,
                pill: KIND_LABEL[r.kind] ?? r.kind,
                details: [
                  { label: "Account", value: r.account },
                  {
                    label: "Native",
                    value: <Money amount={toNum(r.amount_native)} currency={r.currency} />,
                  },
                ],
              }))}
          />
        )}
        {!phone && (
          <Card
            title="All payments"
            subtitle={`${d.rows.length} payment${d.rows.length === 1 ? "" : "s"}`}
            collapsibleId="activity.divs.all"
            defaultOpen={false}
            flush
          >
            <DataTable
              caption="All dividend payments"
              columns={paymentColumns}
              rows={d.rows}
              rowKey={(r) => String(r.id ?? `${r.date}-${r.symbol}-${r.kind}`)}
              defaultSort={{ key: "date", direction: "desc" }}
            />
          </Card>
        )}
      </div>
    );
  })();

  return (
    <div className="activity-page">
      <PageHeader
        title="Activity"
        subtitle="Contributions and dividends."
        actions={
          <SegmentedControl<Tab>
            ariaLabel="Activity type"
            options={[
              { value: "contributions", label: "Contributions" },
              { value: "dividends", label: "Dividends" },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {active.isError && !active.data ? (
        <ErrorState
          title="Could not load activity"
          message={active.error.message}
          onRetry={() => void active.refetch()}
        />
      ) : active.isPending ? (
        <Skeleton height="14rem" />
      ) : tab === "contributions" ? (
        contributions
      ) : (
        dividendsView
      )}
    </div>
  );
}
