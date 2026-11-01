import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, LogOut, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { deletePasskey, invalidateAuth, listPasskeys, logout, registerPasskey } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { usePrefs, type ThemeChoice } from "../../lib/prefs";
import { BACKUP_URL, useSettings, useUpdateSettings, type SettingsPatch } from "../../lib/queries/manage";
import "./Settings.scss";

const THEME_TO_SERVER: Record<ThemeChoice, NonNullable<SettingsPatch["theme"]>> = {
  system: "auto",
  light: "light",
  dark: "dark",
};

export function PasskeysCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const list = useQuery({ queryKey: ["auth", "passkeys"], queryFn: listPasskeys });
  const add = useMutation({
    mutationFn: () => registerPasskey(name.trim() || undefined),
    onSuccess: () => {
      setName("");
      toast({ title: "Passkey added", tone: "success" });
      return qc.invalidateQueries({ queryKey: ["auth"] });
    },
    onError: () => toast({ title: "Could not add the passkey", tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string | number) => deletePasskey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
    onError: (e) =>
      toast({ title: "Could not remove", description: e instanceof ApiError ? e.message : undefined, tone: "error" }),
  });

  return (
    <Card title="Passkeys" subtitle="Sign in with Face ID, Touch ID or a security key.">
      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton height="60px" />
      ) : (
        <ul className="settings__passkeys">
          {list.data.length === 0 && <li className="settings__muted">No passkeys yet.</li>}
          {list.data.map((p) => (
            <li key={p.id} className="settings__passkey">
              <KeyRound aria-hidden size={16} />
              <span className="settings__passkey-name">{p.name || "Passkey"}</span>
              <span className="settings__muted">
                {p.last_used_at ? `Used ${formatDate(p.last_used_at)}` : p.created_at ? `Added ${formatDate(p.created_at)}` : ""}
              </span>
              <IconButton
                label={`Remove passkey ${p.name || p.id}`}
                size="sm"
                icon={<Trash2 aria-hidden />}
                onClick={() => remove.mutate(p.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="settings__inline">
        <Field label="New passkey name (optional)">
          {(c) => <Input {...c} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button variant="secondary" loading={add.isPending} onClick={() => add.mutate()}>
          Add passkey
        </Button>
      </div>
    </Card>
  );
}

export function Settings() {
  const q = useSettings();
  const update = useUpdateSettings();
  const prefs = usePrefs();
  const { toast } = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [interval, setInterval_] = useState<string | null>(null);

  const patch = (body: SettingsPatch) =>
    update.mutate(body, {
      onSuccess: () => toast({ title: "Saved", tone: "success" }),
      onError: (e) =>
        toast({ title: "Could not save", description: e instanceof ApiError ? e.message : undefined, tone: "error" }),
    });

  const signOut = async () => {
    await logout();
    await invalidateAuth(qc);
    navigate("/login");
  };

  const s = q.data;
  return (
    <div className="settings">
      <PageHeader title="Settings" subtitle="Currency, theme, timezone, passkeys and backup." />
      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending || !s ? (
        <Skeleton height="320px" />
      ) : (
        <div className="settings__grid">
          <Card title="General">
            <div className="settings__fields">
              <Field label="Reporting currency">
                <SegmentedControl
                  ariaLabel="Reporting currency"
                  options={[
                    { value: "EUR", label: "EUR" },
                    { value: "USD", label: "USD" },
                  ]}
                  value={s.display_ccy}
                  onChange={(v) => {
                    prefs.setCurrency(v);
                    patch({ display_ccy: v });
                  }}
                />
              </Field>
              <Field label="Theme">
                <SegmentedControl<ThemeChoice>
                  ariaLabel="Theme"
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                  value={prefs.theme}
                  onChange={(v) => {
                    prefs.setTheme(v);
                    patch({ theme: THEME_TO_SERVER[v] });
                  }}
                />
              </Field>
              <Field label="Timezone">
                {(c) => (
                  <Select
                    {...c}
                    options={s.options.timezones.map((t) => ({ value: t, label: t }))}
                    value={s.timezone}
                    onValueChange={(v) => patch({ timezone: v })}
                  />
                )}
              </Field>
              <Field label="Clock format">
                <SegmentedControl
                  ariaLabel="Clock format"
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "12h", label: "12-hour" },
                    { value: "24h", label: "24-hour" },
                  ]}
                  value={s.clock_format}
                  onChange={(v) => patch({ clock_format: v })}
                />
              </Field>
              <Field
                label="Refresh interval (seconds)"
                hint={`Between ${s.options.auto_refresh_min_seconds} and ${s.options.auto_refresh_max_seconds}.`}
              >
                {(c) => (
                  <Input
                    {...c}
                    inputMode="numeric"
                    value={interval ?? String(s.auto_refresh_seconds)}
                    onChange={(e) => setInterval_(e.target.value)}
                    onBlur={() => {
                      if (interval !== null && Number(interval) > 0) patch({ auto_refresh_seconds: Number(interval) });
                      setInterval_(null);
                    }}
                  />
                )}
              </Field>
            </div>
          </Card>

          <Card title="Charts">
            <div className="settings__fields">
              {Object.entries(s.options.chart_pref_keys).map(([key, allowed]) => (
                <Field key={key} label={key.replace(/_/g, " ")}>
                  {(c) =>
                    allowed ? (
                      <Select
                        {...c}
                        options={allowed.map((a) => ({ value: a, label: a }))}
                        value={s.chart_prefs[key] ?? ""}
                        onValueChange={(v) => patch({ chart_prefs: { ...s.chart_prefs, [key]: v } })}
                      />
                    ) : (
                      <Input
                        {...c}
                        defaultValue={s.chart_prefs[key] ?? ""}
                        onBlur={(e) => patch({ chart_prefs: { ...s.chart_prefs, [key]: e.target.value } })}
                      />
                    )
                  }
                </Field>
              ))}
            </div>
          </Card>

          <PasskeysCard />

          <Card title="Backup and session">
            <div className="settings__inline">
              <a className="settings__download" href={BACKUP_URL} download>
                <Download aria-hidden size={16} /> Download backup
              </a>
              <Button variant="danger" leftIcon={<LogOut aria-hidden />} onClick={() => void signOut()}>
                Log out
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
