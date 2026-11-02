import { Download } from "lucide-react";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Skeleton } from "../../components/Skeleton";
import { formatDateTime } from "../../lib/format";
import { backupDownloadUrl, useBackups, useJobCatalogue, useSystemInfo, type BackupsDto } from "../../lib/queries/maintenance";
import { RunJob } from "./RunJob";

type Snapshot = BackupsDto["snapshots"][number];

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function size(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const yesNo = (b: boolean) => (b ? "yes" : "no");

export function SystemTab() {
  const sys = useSystemInfo();
  const backups = useBackups();
  const jobs = useJobCatalogue();
  const job = (id: string) => jobs.data?.jobs.find((j) => j.id === id);
  const backupNow = job("backup.now");
  const verify = job("backup.verify");
  const integrity = job("db.integrity_check");

  const snapColumns: Column<Snapshot>[] = [
    { key: "name", header: "Snapshot", primary: true, cell: (s) => s.name },
    { key: "created", header: "Created", cell: (s) => formatDateTime(s.created), sortValue: (s) => s.created },
    { key: "size", header: "Size", align: "right", cell: (s) => size(s.size_bytes), sortValue: (s) => s.size_bytes },
    {
      key: "actions",
      header: "Actions",
      cell: (s) => (
        <span className="system__row-actions">
          <a className="diagnostics__fix-link" href={backupDownloadUrl(s.name)} download aria-label={`Download ${s.name}`}>
            <Download aria-hidden size={14} /> Download
          </a>
          {verify && <RunJob job={verify} params={{ name: s.name }} label="Verify" variant="ghost" />}
        </span>
      ),
    },
  ];

  return (
    <div className="diagnostics__tab">
      {sys.isError ? (
        <ErrorState onRetry={() => void sys.refetch()} />
      ) : sys.isPending ? (
        <Skeleton height="160px" />
      ) : (
        <Card title="Server" collapsibleId="system.server">
          <dl className="system__facts">
            <dt>Version</dt>
            <dd>
              {sys.data.version}
              {sys.data.image_tag ? ` (image ${sys.data.image_tag})` : ""}
            </dd>
            <dt>Up since</dt>
            <dd>
              {formatDateTime(sys.data.started_at)} ({uptime(sys.data.uptime_seconds)})
            </dd>
            <dt>Database</dt>
            <dd>
              {size(sys.data.db_size_bytes)} · encrypted {yesNo(sys.data.encrypted)} · split tiers {yesNo(sys.data.split_db)}
            </dd>
            {Object.entries(sys.data.migrations).map(([k, v]) => (
              <div key={k} className="system__fact">
                <dt>Migration {k.replace(/_/g, " ")}</dt>
                <dd>{v ?? "–"}</dd>
              </div>
            ))}
            <dt>Scheduler</dt>
            <dd>{sys.data.scheduler_enabled ? "enabled" : "off"}</dd>
            <dt>API token access</dt>
            <dd>{sys.data.api_token_enabled ? "on" : "off"}</dd>
            <dt>Backup passphrase</dt>
            <dd>{sys.data.backup_passphrase_set ? "set" : sys.data.backup_falls_back_to_db_key ? "not set (uses the database key)" : "not set"}</dd>
            {Object.entries(sys.data.paths).map(([k, v]) => (
              <div key={k} className="system__fact">
                <dt>{k.replace(/_/g, " ")}</dt>
                <dd className="system__path">{v}</dd>
              </div>
            ))}
          </dl>
          {sys.data.env_shadowed_by_app.length > 0 && (
            <div className="system__shadowed">
              <p className="diagnostics__muted">
                These server env values are ignored because a value is set in the app (Settings shows both; reset there to use env again):
              </p>
              <span className="diagnostics__chips">
                {sys.data.env_shadowed_by_app.map((k) => (
                  <span key={k} className="diagnostics__chip">
                    {k}
                  </span>
                ))}
              </span>
            </div>
          )}
          {integrity && <RunJob job={integrity} label="Run integrity check" />}
        </Card>
      )}

      <Card
        title="Backups"
        subtitle={backups.data ? `${backups.data.snapshots.length} snapshot(s) in ${backups.data.directory}. Restore stays a server command (see the runbook).` : undefined}
        flush
        collapsibleId="system.backups"
        actions={backupNow && <RunJob job={backupNow} label="Back up now" />}
      >
        {backups.isError ? (
          <ErrorState onRetry={() => void backups.refetch()} />
        ) : (
          <DataTable
            caption="Backup snapshots"
            columns={snapColumns}
            rows={backups.data?.snapshots ?? []}
            rowKey={(s) => s.name}
            loading={backups.isPending}
            defaultSort={{ key: "created", direction: "desc" }}
            emptyMessage={backups.data && !backups.data.configured ? "Backups are not configured on this server." : "No snapshots yet."}
          />
        )}
      </Card>
    </div>
  );
}
