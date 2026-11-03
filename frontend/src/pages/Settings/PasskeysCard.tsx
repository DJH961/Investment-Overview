import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { deletePasskey, listPasskeys, registerPasskey } from "../../lib/auth";
import { formatDate } from "../../lib/format";

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
      {list.isError && !list.data ? (
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
