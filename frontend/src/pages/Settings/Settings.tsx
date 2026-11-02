import { useQueryClient } from "@tanstack/react-query";
import { Download, History, LogOut, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Input } from "../../components/Input";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { invalidateAuth, logout } from "../../lib/auth";
import { BACKUP_URL } from "../../lib/queries/manage";
import {
  SETTINGS_EXPORT_URL,
  authBlock,
  errorMessage,
  fieldErrors,
  reauthHref,
  usePatchSettings,
  useResetSettings,
  useSettingsSchema,
  useSettingsValues,
  type SettingField as FieldDef,
  type SettingJson,
} from "../../lib/queries/settings";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePersistentState } from "../../lib/usePersistentState";
import { AccountsCard } from "./AccountsCard";
import { HistorySheet } from "./HistorySheet";
import { ImportDialog } from "./ImportDialog";
import { PasskeysCard } from "./PasskeysCard";
import { draftToValue, SettingField, type DraftValue } from "./SettingField";
import { UnsavedBar } from "./UnsavedBar";
import "./Settings.scss";

export { PasskeysCard } from "./PasskeysCard";

/** App-only sections (no schema fields) slotted between the server's sections. */
const LOCAL_SECTIONS = [
  { id: "accounts", label: "Accounts", before: "instruments" },
  { id: "security", label: "Security & session", before: "system" },
] as const;

function SecurityCards() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    await logout();
    await invalidateAuth(qc);
    navigate("/login");
  };
  return (
    <>
      <PasskeysCard />
      <Card title="Session">
        <Button variant="danger" leftIcon={<LogOut aria-hidden />} onClick={() => void signOut()}>
          Log out
        </Button>
      </Card>
    </>
  );
}

function BackupCard() {
  return (
    <Card title="Backup files" subtitle="Sealed, encrypted snapshots. Restoring stays a server command (see the runbook).">
      <div className="settings__inline">
        <a className="settings__download" href={BACKUP_URL} download>
          <Download aria-hidden size={16} /> Download latest backup
        </a>
        <Link className="settings__link" to="/diagnostics?tab=system">
          All backups, back up now, verify →
        </Link>
      </div>
    </Card>
  );
}

const EXTRA_CARDS: Record<string, () => ReactNode> = {
  accounts: () => <AccountsCard />,
  security: () => <SecurityCards />,
  backups: () => <BackupCard />,
};

const matches = (f: FieldDef, q: string) =>
  [f.label, f.help, f.key].some((s) => s.toLowerCase().includes(q));

export function Settings() {
  const schema = useSettingsSchema();
  const values = useSettingsValues();
  const patch = usePatchSettings();
  const reset = useResetSettings();
  const { toast } = useToast();
  const phone = useMediaQuery(PHONE_QUERY);

  const [section, setSection] = usePersistentState<string>("settings.section", "display");
  const [advanced, setAdvanced] = usePersistentState<boolean>("settings.advanced", false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saveNote, setSaveNote] = useState<ReactNode>(null);
  const [history, setHistory] = useState<{ open: boolean; key: string | null }>({ open: false, key: null });
  const [importOpen, setImportOpen] = useState(false);
  const [resetSection, setResetSection] = useState<string | null>(null);

  const fields = useMemo(() => schema.data?.fields ?? [], [schema.data]);
  const byKey = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f])), [fields]);

  const sections = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const s of schema.data?.sections ?? []) {
      for (const l of LOCAL_SECTIONS) if (l.before === s.id) out.push(l);
      out.push(s);
    }
    for (const l of LOCAL_SECTIONS) if (!out.some((s) => s.id === l.id)) out.push(l);
    return out;
  }, [schema.data]);
  const active = sections.some((s) => s.id === section) ? section : (sections[0]?.id ?? "display");

  const clientErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, d] of Object.entries(draft)) {
      const f = byKey[k];
      if (!f) continue;
      const r = draftToValue(f, d);
      if ("error" in r) out[k] = r.error;
    }
    return out;
  }, [draft, byKey]);
  const errors = { ...serverErrors, ...clientErrors };
  const dirtyCount = Object.keys(draft).length;

  useEffect(() => {
    if (dirtyCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyCount]);

  const setFieldDraft = (key: string, d: DraftValue | undefined) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (d === undefined) delete next[key];
      else next[key] = d;
      return next;
    });
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = () => {
    if (Object.keys(clientErrors).length) return;
    const changes: Record<string, SettingJson> = {};
    for (const [k, d] of Object.entries(draft)) {
      const r = draftToValue(byKey[k], d);
      if ("value" in r) changes[k] = r.value;
    }
    setSaveNote(null);
    patch.mutate(changes, {
      onSuccess: (r) => {
        setDraft({});
        setServerErrors({});
        toast({ title: r.changed.length ? `Saved ${r.changed.length} setting(s)` : "Nothing changed", tone: "success" });
      },
      onError: (e) => {
        const errs = fieldErrors(e);
        setServerErrors(errs);
        const block = authBlock(e);
        if (block === "reauth") {
          setSaveNote(
            <>
              Changing a secret needs a fresh sign-in. <a href={reauthHref()}>Sign in again</a>, then save.
            </>,
          );
        } else if (block === "session") {
          setSaveNote("Changing a secret needs a signed-in browser session (not the API token).");
        } else if (!Object.keys(errs).length) {
          setSaveNote(errorMessage(e) ?? "Could not save.");
        } else {
          setSaveNote(`${Object.keys(errs).length} setting(s) need fixing.`);
          // Jump to the first bad field's section so the message is visible.
          const first = byKey[Object.keys(errs)[0]];
          if (first && !search) setSection(first.section);
        }
      },
    });
  };

  const resetKeys = (body: { keys?: string[]; section?: string }, label: string) =>
    reset.mutate(body, {
      onSuccess: () => toast({ title: `${label} reset`, tone: "success" }),
      onError: (e) => {
        const block = authBlock(e);
        toast({
          title: "Could not reset",
          description: block === "reauth" ? "Sign in again, then retry." : errorMessage(e),
          tone: "error",
        });
      },
    });

  const q = search.trim().toLowerCase();
  const advancedHidden = (f: FieldDef) => f.level === "advanced" && !advanced;
  const visible = fields.filter((f) => !advancedHidden(f) && (q ? matches(f, q) : f.section === active));
  const hiddenAdvanced = fields.filter((f) => advancedHidden(f) && (q ? matches(f, q) : f.section === active)).length;
  const grouped = q
    ? sections
        .map((s) => ({ section: s, fields: visible.filter((f) => f.section === s.id) }))
        .filter((g) => g.fields.length > 0)
    : [{ section: sections.find((s) => s.id === active) ?? { id: active, label: active }, fields: visible }];

  const renderField = (f: FieldDef) => (
    <SettingField
      key={f.key}
      field={f}
      value={values.data?.[f.key]}
      draft={draft[f.key]}
      error={errors[f.key]}
      onDraft={(d) => setFieldDraft(f.key, d)}
      onReset={() => resetKeys({ keys: [f.key] }, f.label)}
      onHistory={() => setHistory({ open: true, key: f.key })}
      resetting={reset.isPending && reset.variables?.keys?.includes(f.key)}
    />
  );

  return (
    <div className="settings">
      <PageHeader
        title="Settings"
        subtitle="Every setting the app uses, with where each value comes from."
        actions={
          <div className="settings__header-actions">
            <Button size="sm" variant="ghost" leftIcon={<History aria-hidden />} onClick={() => setHistory({ open: true, key: null })}>
              History
            </Button>
            <a className="settings__download settings__download--sm" href={SETTINGS_EXPORT_URL} download>
              <Download aria-hidden size={14} /> Export
            </a>
            <Button size="sm" variant="ghost" leftIcon={<Upload aria-hidden />} onClick={() => setImportOpen(true)}>
              Import
            </Button>
          </div>
        }
      />
      {schema.isError || values.isError ? (
        <ErrorState
          onRetry={() => {
            void schema.refetch();
            void values.refetch();
          }}
        />
      ) : schema.isPending || values.isPending ? (
        <Skeleton height="320px" />
      ) : (
        <div className="settings__layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <Input
              aria-label="Search settings"
              placeholder="Search settings"
              leftIcon={<Search aria-hidden size={14} />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {phone ? (
              <Select
                ariaLabel="Section"
                options={sections.map((s) => ({ value: s.id, label: s.label }))}
                value={active}
                onValueChange={(v) => {
                  setSection(v);
                  setSearch("");
                }}
              />
            ) : (
              <ul className="settings-nav__list">
                {sections.map((s) => {
                  const dirty = fields.some((f) => f.section === s.id && f.key in draft);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        className={`settings-nav__item${s.id === active && !q ? " settings-nav__item--active" : ""}`}
                        aria-current={s.id === active && !q ? "true" : undefined}
                        onClick={() => {
                          setSection(s.id);
                          setSearch("");
                        }}
                      >
                        {s.label}
                        {dirty && <span className="settings-nav__dot" aria-label="unsaved changes" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="settings-nav__advanced">
              <span className="settings-nav__advanced-label">Advanced settings</span>
              <SegmentedControl
                size="sm"
                ariaLabel="Show advanced settings"
                options={[
                  { value: "off", label: "Hide" },
                  { value: "on", label: "Show" },
                ]}
                value={advanced ? "on" : "off"}
                onChange={(v) => setAdvanced(v === "on")}
              />
            </div>
          </nav>

          <div className="settings__content">
            {grouped.map(({ section: s, fields: list }) => (
              <section key={s.id} className="settings__section" aria-labelledby={`settings-${s.id}`}>
                <h2 className="settings__section-title" id={`settings-${s.id}`}>
                  {s.label}
                </h2>
                {list.length > 0 && <div className="settings__fields">{list.map(renderField)}</div>}
                {!q && EXTRA_CARDS[s.id]?.()}
                {!q && list.length === 0 && !EXTRA_CARDS[s.id] && (
                  <p className="settings__muted">Nothing here{hiddenAdvanced ? " unless advanced settings are shown" : ""}.</p>
                )}
                {!q && hiddenAdvanced > 0 && (
                  <button type="button" className="settings__more" onClick={() => setAdvanced(true)}>
                    Show {hiddenAdvanced} advanced setting(s)
                  </button>
                )}
                {!q && list.some((f) => values.data?.[f.key]?.source === "db") && (
                  <div className="settings__section-foot">
                    <Button size="sm" variant="ghost" onClick={() => setResetSection(s.id)}>
                      Reset “{s.label}” to defaults
                    </Button>
                  </div>
                )}
              </section>
            ))}
            {q && grouped.length === 0 && (
              <EmptyState
                icon={<Search aria-hidden />}
                title="No setting matches"
                description={hiddenAdvanced ? `${hiddenAdvanced} advanced setting(s) match; show advanced settings to see them.` : "Try another word."}
              />
            )}
          </div>
        </div>
      )}

      <UnsavedBar
        count={dirtyCount}
        invalid={Object.keys(clientErrors).length > 0}
        saving={patch.isPending}
        note={saveNote}
        onSave={save}
        onDiscard={() => {
          setDraft({});
          setServerErrors({});
          setSaveNote(null);
        }}
      />

      <HistorySheet
        open={history.open}
        onOpenChange={(open) => setHistory((h) => ({ ...h, open }))}
        settingKey={history.key}
        fields={byKey}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} fields={byKey} />
      <Dialog
        open={resetSection !== null}
        onOpenChange={(o) => !o && setResetSection(null)}
        title="Reset this section?"
        description="Every value set in the app for this section goes back to the server env value or the default. The history keeps the old values, so you can revert."
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetSection(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={reset.isPending}
              onClick={() => {
                const sid = resetSection;
                setResetSection(null);
                if (sid) resetKeys({ section: sid }, sections.find((s) => s.id === sid)?.label ?? sid);
              }}
            >
              Reset section
            </Button>
          </>
        }
      />
    </div>
  );
}
