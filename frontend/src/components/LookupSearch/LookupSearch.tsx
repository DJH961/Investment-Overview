import clsx from "clsx";
import { Search } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { Input } from "../Input";
import { type LookupResultDto, useLookupSearch } from "../../lib/queries/lookup";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import "./LookupSearch.scss";

export const lookupTarget = (r: LookupResultDto): string =>
  r.held_instrument_id != null ? `/holdings/${r.held_instrument_id}` : `/lookup/${encodeURIComponent(r.symbol)}`;

/**
 * Look up any instrument by symbol or name (7.1, P20). Owned ones open their holding
 * page; anything else opens the "not held" lookup page. Typing is debounced, so a
 * word is one request.
 */
export function LookupSearch({ className, placeholder = "Look up a symbol" }: { className?: string; placeholder?: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(text);
  const search = useLookupSearch(q);
  const navigate = useNavigate();
  const listId = useId();
  const results = q.trim() ? (search.data?.results ?? []) : [];
  const show = open && text.trim() !== "";

  const go = (r: LookupResultDto) => {
    setOpen(false);
    setText("");
    navigate(lookupTarget(r));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[Math.min(active, results.length - 1)];
      if (r) go(r);
    }
  };

  return (
    <div className={clsx("lookup-search", className)}>
      <Input
        type="search"
        aria-label="Look up an instrument"
        aria-controls={listId}
        placeholder={placeholder}
        leftIcon={<Search aria-hidden size={16} />}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        // Late enough for a click on a result to land first.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {show && (
        <div className="lookup-search__panel">
          {search.isFetching && results.length === 0 ? (
            <p className="lookup-search__note">Searching…</p>
          ) : search.isError ? (
            <p className="lookup-search__note">Search is not available right now.</p>
          ) : results.length === 0 && q.trim() === text.trim() && !search.isPending ? (
            <p className="lookup-search__note">No match for “{text.trim()}”.</p>
          ) : (
            <ul id={listId} aria-label="Instruments" className="lookup-search__list">
              {results.map((r, i) => (
                <li key={`${r.symbol}-${r.exchange ?? ""}`}>
                  <button
                    type="button"
                    className={clsx("lookup-search__item", i === active && "lookup-search__item--active")}
                    // Keep the box focused until the click lands.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(r)}
                  >
                    <span className="lookup-search__symbol">
                      {r.symbol}
                      {r.held_instrument_id != null && <span className="lookup-search__owned">you own this</span>}
                    </span>
                    <span className="lookup-search__meta">{[r.exchange, r.type].filter(Boolean).join(" · ")}</span>
                    <span className="lookup-search__name">{r.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
