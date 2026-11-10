import { ChevronDown, Download, History, LogOut, Search, Upload } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Input } from "../../components/Input";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useHideAmounts } from "../../lib/hideAmounts";
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
import { useLeaveGuard } from "../../lib/useLeaveGuard";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePersistentState } from "../../lib/usePersistentState";
import { restartSetupGuide } from "../../lib/setupGuide";
import { useSignOut } from "../../lib/useSignOut";
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
  const signOut = useSignOut();
  const navigate = useNavigate();
  return (
    <>
      <PasskeysCard />
      <Card title="Setup guide" subtitle="This device only">
        <Button
          variant="secondary"
          onClick={() => {
            restartSetupGuide();
            navigate("/overview");
          }}
        >
          Restart setup guide
        </Button>
      </Card>
      <Card title="Session">
        <Button variant="danger" leftIcon={<LogOut aria-hidden />} onClick={() => void signOut()}>
          Sign out
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

function HideNumbersCard() {
  const { hide, setHide } = useHideAmounts();
  return (
    <Card title="Hide numbers" subtitle="This device only">
      <label className="settings__switch">
        <input type="checkbox" role="switch" aria-checked={hide} checked={hide} onChange={(e) => setHide(e.target.checked)} />
        <span>Hide amounts and share counts (percentages, names and weights stay visible).</span>
      </label>
    </Card>
  );
}

const EXTRA_CARDS: Record<string, () => ReactNode> = {
  display: () => <HideNumbersCard />,
  accounts: () => <AccountsCard />,
  security: () => <SecurityCards />,
  backups: () => <BackupCard />,
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

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
  const [search, setSearch] = useState("");
  // Phone: which foldable sections are open (remembered per device).
  const [openSections, setOpenSections] = usePersistentState<string[]>("settings.open", ["display"], isStringList);
  const toggleSection = (id: string) =>
    setOpenSections((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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

  // In-app navigation (sidebar, shortcuts, back) asks first; reloads get the browser prompt.
  const leaveGuard = useLeaveGuard({
    when: dirtyCount > 0,
    title: "Leave without saving?",
    description: `You have ${dirtyCount} unsaved setting change${dirtyCount === 1 ? "" : "s"}. Leaving discards ${dirtyCount === 1 ? "it" : "them"}.`,
    leaveLabel: "Discard and leave",
    onLeave: () => setDraft({}),
  });

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
          if (first && !search) {
            setSection(first.section);
            setOpenSections((prev) => (prev.includes(first.section) ? prev : [...prev, first.section]));
          }
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
  // Every setting is visible; advanced ones just carry an "Advanced" badge (see SettingField).
  const visible = fields.filter((f) => (q ? matches(f, q) : f.section === active));
  const grouped = q
    ? sections
        .map((s) => ({ section: s, fields: visible.filter((f) => f.section === s.id) }))
        .filter((g) => g.fields.length > 0)
    : [{ section: sections.find((s) => s.id === active) ?? { id: active, label: active }, fields: visible }];

  const sectionBody = (s: { id: string; label: string }, list: FieldDef[]) => (
    <>
      {list.length > 0 &&
        (values.data ? (
          <div className="settings__fields">{list.map(renderField)}</div>
        ) : (
          // Field rows need the values (they would show as "default" otherwise); the rest renders now.
          <Skeleton height="160px" />
        ))}
      {!q && EXTRA_CARDS[s.id]?.()}
      {!q && list.length === 0 && !EXTRA_CARDS[s.id] && (
        <p className="settings__muted">Nothing here.</p>
      )}
      {!q && list.some((f) => values.data?.[f.key]?.source === "db") && (
        <div className="settings__section-foot">
          <Button size="sm" variant="ghost" onClick={() => setResetSection(s.id)}>
            Reset “{s.label}” to defaults
          </Button>
        </div>
      )}
    </>
  );

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
      {leaveGuard}
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
      {(schema.isError && !schema.data) || (values.isError && !values.data) ? (
        <ErrorState
          onRetry={() => {
            void schema.refetch();
            void values.refetch();
          }}
        />
      ) : !schema.data ? (
        <Skeleton height="320px" />
      ) : (
        <div className="settings__layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <Input
              aria-label="Search settings"
              placeholder="Search settings"
              leftIcon={<Search aria-hidden size={14} />}
              value={search}
              data-search
              onChange={(e) => setSearch(e.target.value)}
            />
            {!phone && (
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
                        {dirty && <>
                            <span className="settings-nav__dot" aria-hidden />
                            <span className="settings-nav__sr">unsaved changes</span>
                          </>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>

          <div className="settings__content">
            {phone && !q
              ? // Phone: one long page of foldable sections (no section picker).
                sections.map((s) => {
                  const list = fields.filter((f) => f.section === s.id);
                  const open = openSections.includes(s.id);
                  const dirty = fields.some((f) => f.section === s.id && f.key in draft);
                  const bodyId = `settings-body-${s.id}`;
                  return (
                    <section
                      key={s.id}
                      className={`settings-fold${open ? " settings-fold--open" : ""}`}
                      aria-labelledby={`settings-${s.id}`}
                    >
                      <h2 className="settings-fold__heading" id={`settings-${s.id}`}>
                        <button
                          type="button"
                          className="settings-fold__toggle"
                          aria-expanded={open}
                          aria-controls={bodyId}
                          onClick={() => toggleSection(s.id)}
                        >
                          <ChevronDown aria-hidden className="settings-fold__chevron" />
                          <span className="settings-fold__label">{s.label}</span>
                          {dirty && <>
                            <span className="settings-nav__dot" aria-hidden />
                            <span className="settings-nav__sr">unsaved changes</span>
                          </>}
                          {list.length > 0 && <span className="settings-fold__count">{list.length}</span>}
                        </button>
                      </h2>
                      {open && (
                        <div className="settings-fold__body" id={bodyId}>
                          {sectionBody(s, list)}
                        </div>
                      )}
                    </section>
                  );
                })
              : grouped.map(({ section: s, fields: list }) => (
                  <section key={s.id} className="settings__section" aria-labelledby={`settings-${s.id}`}>
                    <h2 className="settings__section-title" id={`settings-${s.id}`}>
                      {s.label}
                    </h2>
                    {sectionBody(s, list)}
                  </section>
                ))}
            {q && grouped.length === 0 && (
              <EmptyState
                icon={<Search aria-hidden />}
                title="No setting matches"
                description="Try another word."
              />
            )}
          </div>
        </div>
      )}

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
