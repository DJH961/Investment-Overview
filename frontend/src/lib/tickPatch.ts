/**
 * Put a live tick straight into the cached "both currencies" queries (no request):
 * totals, the newest intraday point of the 1d / 1w graphs and the holdings rows'
 * price and the server's day figures. The staggered refetch that follows corrects anything approximated here.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { components } from "./api-types";
import type { GraphDto, OverviewDto } from "./queries/portfolio";
import type { HoldingGroupDto, HoldingRowDto, HoldingsDto } from "./queries/holdings";

type Ccy = "EUR" | "USD";
const SIDES: Ccy[] = ["EUR", "USD"];
type Both<T> = Record<Ccy, T>;
export type TickPointDto = components["schemas"]["TickPoint"];
export type TickPriceDto = components["schemas"]["TickPrice"];
export type TickEstimateDto = components["schemas"]["TickEstimate"];
export type TickCategoryDto = components["schemas"]["TickCategory"];

const decimal = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The shape of a tick as `handleLiveEvent` sees it (loosely typed SSE payload). */
export interface TickLike {
  total_value_eur?: unknown;
  total_value_usd?: unknown;
  total_value_est_eur?: unknown;
  total_value_est_usd?: unknown;
  estimates?: unknown;
  fx_eur_usd?: unknown;
  last_update_at?: unknown;
  prices_live?: unknown;
  point?: unknown;
  prices?: unknown;
  categories?: unknown;
  seq?: unknown;
}

type KpisDto = OverviewDto["kpis"];

/**
 * Move the estimated total (and its gap to the official one) to the tick's value.
 * Never creates or removes an estimate: the refetch that follows does that.
 */
function withEstimate(kpis: KpisDto, estTotal: string | null): KpisDto {
  const e = kpis.estimate;
  if (!e || !estTotal) return kpis;
  const official = Number(kpis.total_value);
  const total = Number(estTotal);
  const adjustment = Number.isFinite(official) && Number.isFinite(total) ? String(total - official) : e.adjustment;
  return { ...kpis, estimate: { ...e, total_value: estTotal, adjustment } };
}

/** Totals, the rate and the freshness chip, on both sides of every cached overview. */
export function patchOverviewFromEvent(queryClient: QueryClient, ev: TickLike): void {
  const eur = decimal(ev.total_value_eur);
  const usd = decimal(ev.total_value_usd);
  const fx = decimal(ev.fx_eur_usd);
  const last = typeof ev.last_update_at === "string" ? ev.last_update_at : null;
  const live = typeof ev.prices_live === "boolean" ? ev.prices_live : null;
  const total: Both<string | null> = { EUR: eur, USD: usd };
  // The estimated book (kpis stay official): only where the server said one exists.
  const est: Both<string | null> = { EUR: decimal(ev.total_value_est_eur), USD: decimal(ev.total_value_est_usd) };
  for (const [key, data] of queryClient.getQueriesData<Both<OverviewDto>>({ queryKey: ["overview", "both"] })) {
    if (!data || typeof data !== "object") continue;
    const next = { ...data };
    for (const side of SIDES) {
      const dto = data[side];
      if (!dto?.kpis) continue;
      const primary = total[side];
      const secondary = total[side === "EUR" ? "USD" : "EUR"];
      const other = side === "EUR" ? "USD" : "EUR";
      next[side] = {
        ...dto,
        fx_eur_usd: fx ?? dto.fx_eur_usd,
        kpis: withEstimate(primary ? { ...dto.kpis, total_value: primary } : dto.kpis, est[side]),
        kpis_secondary: dto.kpis_secondary
          ? withEstimate(
              secondary ? { ...dto.kpis_secondary, total_value: secondary } : dto.kpis_secondary,
              est[other],
            )
          : dto.kpis_secondary,
        freshness: dto.freshness
          ? {
              ...dto.freshness,
              ...(last ? { last_price_update_at: last } : {}),
              ...(live !== null ? { prices_live: live } : {}),
            }
          : dto.freshness,
      };
    }
    queryClient.setQueryData<Both<OverviewDto>>(key, next);
  }
}

const INTRADAY_RANGES = ["1d", "1w"];
const DAILY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "all"];

function withPoint(points: GraphDto["points"], t: string, v: string): GraphDto["points"] {
  const last = points[points.length - 1];
  if (last && last.t === t) return [...points.slice(0, -1), { t, v }];
  if (last && last.t > t) return points; // older than what is on screen
  return [...points, { t, v }];
}

/**
 * Daily ranges carry one point per date (`t` = "YYYY-MM-DD"): today's value replaces
 * the last point when it is the same (UTC) day, is appended when newer, and is ignored
 * when older. Never touches earlier points.
 */
function withDailyPoint(points: GraphDto["points"], t: string, v: string): GraphDto["points"] {
  const day = t.slice(0, 10);
  const last = points[points.length - 1];
  if (!last) return points; // nothing drawn yet: leave it to the fetch
  const lastDay = last.t.slice(0, 10);
  if (lastDay === day) return [...points.slice(0, -1), { ...last, v }];
  if (lastDay > day) return points;
  return [...points, { t: day, v }];
}

/** Append (or replace, same `t`) the live sample in every cached graph range, both sides. */
export function patchGraphPoint(queryClient: QueryClient, point: TickPointDto): void {
  if (!point || typeof point.t !== "string" || point.t === "") return;
  const ranges: Array<[string, typeof withPoint]> = [
    ...INTRADAY_RANGES.map((r): [string, typeof withPoint] => [r, withPoint]),
    ...DAILY_RANGES.map((r): [string, typeof withPoint] => [r, withDailyPoint]),
  ];
  for (const [range, add] of ranges) {
    for (const [key, data] of queryClient.getQueriesData<Both<GraphDto>>({ queryKey: ["graphs", range, "both"] })) {
      if (!data || typeof data !== "object") continue;
      const next = { ...data };
      for (const side of SIDES) {
        const g = data[side];
        if (!g || !Array.isArray(g.points)) continue;
        const own = decimal(point[side]);
        const sec = g.secondary ? decimal(point[g.secondary.ccy]) : null;
        next[side] = {
          ...g,
          points: own ? add(g.points, point.t, own) : g.points,
          secondary: g.secondary && sec ? { ...g.secondary, points: add(g.secondary.points, point.t, sec) } : g.secondary,
        };
      }
      queryClient.setQueryData<Both<GraphDto>>(key, next);
    }
  }
}

/** Native -> reporting factor: same currency 1, else the EUR/USD rate (USD per EUR). */
function nativeFactor(native: string, side: Ccy, fx: number | null): number | null {
  if (native === side) return 1;
  if (fx && fx > 0 && native === "USD" && side === "EUR") return 1 / fx;
  if (fx && fx > 0 && native === "EUR" && side === "USD") return fx;
  return null;
}

function patchRow(row: HoldingRowDto, side: Ccy, fx: number | null, p: TickPriceDto): HoldingRowDto {
  const px = Number(p.px);
  const shares = Number(row.shares);
  if (!Number.isFinite(px) || !Number.isFinite(shares)) return row;
  const factor = nativeFactor(row.native_currency, side, fx);
  if (factor === null) return row;
  const next: HoldingRowDto = { ...row, price_native: p.px, value: String(shares * px * factor) };
  // The day move and day % are the server's (FX-aware, per side): copied, never computed here.
  // A value the tick does not carry leaves the row's figure alone.
  const move = decimal(side === "EUR" ? p.day_move_eur : p.day_move_usd);
  const pct = decimal(side === "EUR" ? p.day_pct_eur : p.day_pct_usd);
  if (move !== null) next.today_move = move;
  if (pct !== null) next.today_pct = pct;
  return next;
}

/** A pending twin's estimate: value = shares x est price x rate; the % is the server's. */
function patchTwin(row: HoldingRowDto, side: Ccy, fx: number | null, e: TickEstimateDto): HoldingRowDto {
  const twin = row.twin;
  if (!twin || !twin.pending) return row;
  const estPx = Number(e.est_px);
  const prevNav = Number(e.prev_nav);
  const shares = Number(row.shares);
  if (!Number.isFinite(estPx) || !Number.isFinite(prevNav) || !Number.isFinite(shares)) return row;
  const factor = nativeFactor(row.native_currency, side, fx);
  if (factor === null) return row;
  const pct = decimal(e.pct?.[side]);
  return {
    ...row,
    twin: {
      ...twin,
      est_price: e.est_px,
      est_value: String(shares * estPx * factor),
      est_today_move: String(shares * (estPx - prevNav) * factor),
      est_today_pct: pct ?? twin.est_today_pct,
      at: e.at,
    },
  };
}

/** A category group's day move and % from the tick (server figures, copied). */
function patchGroup(g: HoldingGroupDto, side: Ccy, c: TickCategoryDto | undefined): HoldingGroupDto {
  if (!c) return g;
  const move = decimal(side === "EUR" ? c.day_move_eur : c.day_move_usd);
  const pct = decimal(side === "EUR" ? c.day_pct_eur : c.day_pct_usd);
  return { ...g, ...(move !== null ? { today_move: move } : {}), ...(pct !== null ? { today_pct: pct } : {}) };
}

/** Rows' price, value and day figures from the tick's native prices (linear: shares x price x rate). */
export function patchHoldingsPrices(
  queryClient: QueryClient,
  prices: Record<string, TickPriceDto> | null,
  tickFx: string | null,
  estimates: Record<string, TickEstimateDto> | null = null,
  categories: Record<string, TickCategoryDto> | null = null,
): void {
  for (const [key, data] of queryClient.getQueriesData<Both<HoldingsDto>>({ queryKey: ["holdings", "both"] })) {
    if (!data || typeof data !== "object") continue;
    const next = { ...data };
    for (const side of SIDES) {
      const h = data[side];
      if (!h?.holdings) continue;
      const fxRaw = tickFx ?? h.fx_eur_usd ?? null;
      const fx = fxRaw === null ? null : Number(fxRaw);
      const fxOk = fx !== null && Number.isFinite(fx) ? fx : null;
      next[side] = {
        ...h,
        holdings: h.holdings.map((row) => {
          const key = String(row.instrument_id);
          const p = prices?.[key];
          let out = p ? patchRow(row, side, fxOk, p) : row;
          const e = estimates?.[key];
          if (e) out = patchTwin(out, side, fxOk, e);
          return out;
        }),
        groups: h.groups && categories ? h.groups.map((g) => patchGroup(g, side, categories[g.key])) : h.groups,
      };
    }
    queryClient.setQueryData<Both<HoldingsDto>>(key, next);
  }
}

/** Everything one tick changes on screen without a request. */
export function applyTick(queryClient: QueryClient, ev: TickLike): void {
  patchOverviewFromEvent(queryClient, ev);
  const point = ev.point as TickPointDto | null | undefined;
  if (point && typeof point === "object") patchGraphPoint(queryClient, point);
  const prices = ev.prices as Record<string, TickPriceDto> | null | undefined;
  const estimates = ev.estimates as Record<string, TickEstimateDto> | null | undefined;
  const hasPrices = !!prices && typeof prices === "object";
  const hasEstimates = !!estimates && typeof estimates === "object";
  const categories = ev.categories as Record<string, TickCategoryDto> | null | undefined;
  const hasCategories = !!categories && typeof categories === "object";
  if (hasPrices || hasEstimates || hasCategories) {
    patchHoldingsPrices(
      queryClient,
      prices ?? null,
      decimal(ev.fx_eur_usd),
      estimates ?? null,
      hasCategories ? categories : null,
    );
  }
}
