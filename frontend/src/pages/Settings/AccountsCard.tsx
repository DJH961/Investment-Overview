import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import {
  ACCOUNT_BROKERS,
  ACCOUNT_TYPES,
  useAccounts,
  useDeleteAccount,
  useSaveAccount,
  type Account,
  type AccountInput,
} from "../../lib/queries/accounts";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : undefined);

interface EditorProps {
  account?: Account;
  onDone: (saved?: Account) => void;
}

/** Create or edit an account. Broker and currency are locked server-side once transactions exist. */
export function AccountEditor({ account, onDone }: EditorProps) {
  const save = useSaveAccount();
  const { toast } = useToast();
  const [label, setLabel] = useState(account?.account_label ?? "");
  const [type, setType] = useState(account?.account_type ?? "brokerage");
  const [broker, setBroker] = useState(account?.broker ?? ACCOUNT_BROKERS[0]);
  const [ccy, setCcy] = useState(account?.native_currency ?? "USD");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!label.trim()) {
      setError("Enter a label");
      return;
    }
    setError(null);
    const body: AccountInput = {
      account_label: label.trim(),
      account_type: type as AccountInput["account_type"],
      broker: broker as AccountInput["broker"],
      native_currency: ccy.trim().toUpperCase(),
    };
    save.mutate(
      { id: account?.id, body },
      {
        onSuccess: (saved) => {
          toast({ title: account ? "Account updated" : "Account created", tone: "success" });
          onDone(saved);
        },
        onError: (e) => setError(errMsg(e) ?? "Could not save the account"),
      },
    );
  };

  return (
    <div className="settings__account-editor">
      <div className="settings__inline">
        <Field label="Label">{(c) => <Input {...c} value={label} onChange={(e) => setLabel(e.target.value)} />}</Field>
        <Field label="Type">
          {(c) => (
            <Select
              id={c.id}
              options={ACCOUNT_TYPES.map((t) => ({ value: t, label: t }))}
              value={type}
              onValueChange={setType}
            />
          )}
        </Field>
        <Field label="Broker">
          {(c) => (
            <Select
              id={c.id}
              options={ACCOUNT_BROKERS.map((b) => ({ value: b, label: b.replace("_", " ") }))}
              value={broker}
              onValueChange={setBroker}
            />
          )}
        </Field>
        <Field label="Currency">
          {(c) => <Input {...c} maxLength={3} value={ccy} onChange={(e) => setCcy(e.target.value)} />}
        </Field>
      </div>
      {error && (
        <p className="settings__error" role="alert">
          {error}
        </p>
      )}
      <div className="settings__inline">
        <Button loading={save.isPending} onClick={submit}>
          {account ? "Save" : "Create account"}
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AccountsCard() {
  const list = useAccounts();
  const remove = useDeleteAccount();
  const { toast } = useToast();
  const [editing, setEditing] = useState<number | "new" | null>(null);

  return (
    <Card title="Accounts" subtitle="Broker and currency are fixed once an account has transactions.">
      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton height="60px" />
      ) : (
        <ul className="settings__passkeys">
          {list.data.length === 0 && <li className="settings__muted">No accounts yet.</li>}
          {list.data.map((a) =>
            editing === a.id ? (
              <li key={a.id}>
                <AccountEditor account={a} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={a.id} className="settings__passkey">
                <span className="settings__passkey-name">{a.account_label}</span>
                <span className="settings__muted">
                  {a.broker.replace("_", " ")} · {a.native_currency} · {a.account_type ?? "no type"} · {a.transaction_count}{" "}
                  transactions
                </span>
                <IconButton
                  label={`Edit account ${a.account_label}`}
                  size="sm"
                  icon={<Pencil aria-hidden />}
                  onClick={() => setEditing(a.id)}
                />
                <IconButton
                  label={
                    a.transaction_count > 0
                      ? `Cannot delete ${a.account_label}: it has transactions`
                      : `Delete account ${a.account_label}`
                  }
                  size="sm"
                  disabled={a.transaction_count > 0}
                  icon={<Trash2 aria-hidden />}
                  onClick={() =>
                    remove.mutate(a.id, {
                      onError: (e) => toast({ title: "Could not delete", description: errMsg(e), tone: "error" }),
                    })
                  }
                />
              </li>
            ),
          )}
        </ul>
      )}
      {editing === "new" ? (
        <AccountEditor onDone={() => setEditing(null)} />
      ) : (
        <Button variant="secondary" onClick={() => setEditing("new")}>
          Add account
        </Button>
      )}
    </Card>
  );
}
