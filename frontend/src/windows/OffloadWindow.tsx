/**
 * Offloading in one window: the drive on top, then MOVE (copy folders to it,
 * verified), DRIVES (what is on which drive; check it, bring it back, remove
 * the originals) and FIND (any offloaded file, whether or not its drive is
 * plugged in), as sections of which one is open at a time.
 */
import { useEffect } from "react";
import { formatBytes } from "../api";
import { isTauri } from "../desktop";
import type { OffloadJob, OffloadProblem, OffloadProgress, OffloadReport, OffloadStore, RemoveMode } from "../offloadApi";
import { useApp } from "../state/app";
import {
  cancelAction,
  cancelOffload,
  checkJob,
  chosenSources,
  forgetJob,
  importStore,
  loadCatalog,
  loadVolumes,
  modeWords,
  offloadBusy,
  patchOffload,
  releaseJob,
  removalLines,
  resetOffload,
  restoreJob,
  selectJob,
  setDest,
  setQuery,
  showProblems,
  startOffload,
  togglePick,
  useOffload,
  type OffloadSection,
  type OffloadState,
} from "../state/offload";
import { Window } from "../wm/Window";
import { baseName, formatDate } from "./common";
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";
import { Section } from "./Section";

const PHASE_WORDS: Record<OffloadProgress["phase"], string> = {
  starting: "STARTING",
  counting: "COUNTING",
  copying: "COPYING + VERIFYING",
  removing: "CHECKING AGAIN, THEN REMOVING",
  checking: "READING BACK",
  restoring: "RESTORING",
};

const MODES: { mode: RemoveMode; label: string }[] = [
  { mode: "keep", label: "KEEP ORIGINALS" },
  { mode: "trash", label: "THEN TRASH" },
  { mode: "delete", label: "THEN DELETE" },
];

function percent(p: OffloadProgress | null): number {
  if (!p) return 0;
  // Removing reads nothing new into the byte count: it goes by files.
  const byFiles = p.phase === "removing" || !p.bytes_total;
  const [done, total] = byFiles ? [p.files_done, p.files_total] : [p.bytes_done, p.bytes_total];
  return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
}

function ProgressRows({ progress }: { progress: OffloadProgress | null }) {
  const pct = percent(progress);
  return (
    <>
      <div className="seekbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="lcd stats">
        <span className="lcd-accent">{progress ? PHASE_WORDS[progress.phase] : "STARTING"}</span>
        <span>
          {(progress?.files_done ?? 0).toLocaleString()}
          {progress?.files_total ? ` / ${progress.files_total.toLocaleString()}` : ""} files
        </span>
        <span>{formatBytes(progress?.bytes_done ?? 0)}</span>
        {progress?.problems ? <span className="lcd-bad">{progress.problems.toLocaleString()} problems</span> : null}
        <span className="lcd-dim lcd-ellipsis">{progress?.current_path}</span>
      </div>
    </>
  );
}

function Problems({ problems, total }: { problems: OffloadProblem[]; total: number }) {
  if (!total) return null;
  return (
    <div className="off-problems">
      {problems.map((p, i) => (
        <div key={`${p.path}-${i}`} className="off-problem" title={`${p.path}\n${p.message}`}>
          <span className="lcd-bad">{p.kind}</span> <span className="lcd-strong">{p.path || "(the folder itself)"}</span>{" "}
          <span className="lcd-dim">{p.message}</span>
        </div>
      ))}
      {total > problems.length ? <div className="lcd-dim">…and {(total - problems.length).toLocaleString()} more. PROBLEMS on the offload in DRIVES lists them.</div> : null}
    </div>
  );
}

function ReportView({ report }: { report: OffloadReport }) {
  const good = report.outcome === "complete";
  const headline = good
    ? "VERIFIED"
    : report.outcome === "cancelled"
      ? "CANCELLED"
      : `INCOMPLETE${report.stopped ? ` · ${report.stopped}` : ""}`;
  return (
    <div className="off-report">
      <div className="off-report-head">
        <span className={good ? "lcd-accent" : "lcd-bad"}>{headline}</span>
        <span className="lcd-strong lcd-ellipsis" title={report.source}>
          {report.source}
        </span>
      </div>
      <div>
        {report.verified_files.toLocaleString()} of {report.items_seen.toLocaleString()} items verified on "{report.store_label}" ({formatBytes(report.verified_bytes)})
        {report.already_files ? `, ${report.already_files.toLocaleString()} of them were already there` : ""}
      </div>
      {report.failed || report.skipped ? (
        <div className="lcd-bad">
          {report.failed ? `${report.failed.toLocaleString()} not copied` : ""}
          {report.failed && report.skipped ? ", " : ""}
          {report.skipped ? `${report.skipped.toLocaleString()} skipped` : ""}. Their originals were left alone.
        </div>
      ) : null}
      {removalLines(report.removal).map((line) => (
        <div key={line}>{line}</div>
      ))}
      <Problems problems={report.problems} total={report.problems_total} />
    </div>
  );
}

function MoveSection({ s }: { s: OffloadState }) {
  const busy = offloadBusy(s);
  const sources = chosenSources(s);
  if (s.phase === "running" || s.phase === "planning") {
    return (
      <div className="off-pane">
        <div className="lcd lcd-banner">
          <span className="lcd-ellipsis">
            {s.phase === "planning"
              ? "Checking the folders and the drive…"
              : `${s.sources.length > 1 ? `${s.running + 1} of ${s.sources.length} · ` : ""}${s.sources[s.running] ?? ""}`}
          </span>
        </div>
        {s.phase === "running" ? <ProgressRows progress={s.progress} /> : null}
        <div className="lcd off-scroll">
          {s.reports.map((r) => (
            <ReportView key={r.job_id} report={r} />
          ))}
          <div className="lcd-dim">Stopping is safe at any moment: a file counts only once its copy has been read back, and the next run picks up where this one stopped.</div>
        </div>
        <div className="field-row is-end">
          <button type="button" className="steel-btn is-warn" onClick={cancelOffload} disabled={s.phase !== "running"}>
            CANCEL
          </button>
        </div>
      </div>
    );
  }
  if (s.phase === "done" || s.phase === "error") {
    return (
      <div className="off-pane">
        <div className="lcd off-scroll">
          {s.error ? <div className="lcd-bad">STOPPED · {s.error}</div> : null}
          {s.reports.map((r) => (
            <ReportView key={r.job_id} report={r} />
          ))}
        </div>
        <div className="field-row is-end">
          <button type="button" className="steel-btn" onClick={resetOffload}>
            {s.phase === "error" ? "BACK" : "DONE"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="off-pane">
      <div className="field-row">
        <span className="field-tag off-tag">FROM</span>
        <input
          className="lcd-input"
          value={s.sourceInput}
          placeholder={s.candidates.some((c) => s.picked[c.path]) ? "(the ticked folders below)" : "/path/to/folder to move"}
          onChange={(e) => patchOffload({ sourceInput: e.target.value })}
          spellCheck={false}
          aria-label="Folder to offload"
          disabled={s.candidates.some((c) => s.picked[c.path])}
        />
        <button
          type="button"
          className="steel-btn"
          onClick={async () => {
            const picked = await pickDirectory();
            if (picked) patchOffload({ sourceInput: picked, picked: {} });
          }}
        >
          BROWSE
        </button>
      </div>
      <div className="lcd off-scroll" role="list">
        {s.candidatesLoading ? <div className="lcd-dim blink">READING THE SCAN…</div> : null}
        {!s.candidatesLoading && s.candidates.length === 0 ? (
          <div className="lcd-dim">
            {s.candidatesFrom
              ? `Nothing in ${s.candidatesFrom} stands out as big and unused. Pick any folder above.`
              : "Pick a folder above. Or scan a folder and press OFFLOAD on its results: the big folders nothing has touched in a long time are listed here to tick."}
          </div>
        ) : null}
        {s.candidates.map((c) => (
          <label key={c.path} role="listitem" className={`off-row ${s.picked[c.path] ? "is-on" : ""}`} title={c.path}>
            <input type="checkbox" checked={!!s.picked[c.path]} onChange={() => togglePick(c.path)} />
            <span className="off-name">{c.path}</span>
            {c.status === "copied" ? <span className="lcd-accent">on {c.store_label || "a drive"}</span> : null}
            <span className="lcd-dim">{c.idle_days >= 730 ? `${Math.floor(c.idle_days / 365)}y idle` : `${c.idle_days}d idle`}</span>
            <span className="off-size">{formatBytes(c.bytes)}</span>
          </label>
        ))}
      </div>
      <div className="field-row">
        <div className="seg is-wide" role="radiogroup" aria-label="What happens to the originals">
          {MODES.map(({ mode, label }) => (
            <button key={mode} type="button" role="radio" aria-checked={s.remove === mode} className={`seg-btn ${s.remove === mode ? "is-on" : ""}`} onClick={() => patchOffload({ remove: mode })}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="steel-btn is-primary" onClick={() => void startOffload()} disabled={busy || !sources.length || !s.dest.trim()}>
          {sources.length > 1 ? `START (${sources.length})` : "START"}
        </button>
      </div>
      <div className="hint">Every file is copied, read back from the drive and compared. {modeWords(s.remove)}</div>
    </div>
  );
}

function jobBadge(job: OffloadJob, host: string | undefined): { text: string; bad: boolean } {
  if (job.damaged_files) return { text: `${job.damaged_files.toLocaleString()} damaged or missing on the drive`, bad: true };
  if (job.state !== "complete") return { text: job.state === "running" ? "interrupted" : "incomplete", bad: true };
  if (job.problem_files) return { text: `${job.problem_files.toLocaleString()} not copied`, bad: true };
  // Whether another computer still has its originals isn't known here.
  if (job.host !== host) return { text: `from ${job.host}`, bad: false };
  if (job.verified_files > 0 && job.removed_files >= job.verified_files) return { text: "only on the drive", bad: false };
  if (job.removed_files > 0) return { text: "partly removed here", bad: false };
  return { text: "copy · originals still here", bad: false };
}

function JobActions({ s, job, store }: { s: OffloadState; job: OffloadJob; store: OffloadStore | undefined }) {
  const busy = offloadBusy(s);
  const connected = !!store?.path;
  const running = s.action?.jobId === job.id ? s.action : null;
  const left = job.verified_files - job.removed_files;
  const result = s.result?.jobId === job.id ? s.result : null;
  const rows = s.jobProblems?.jobId === job.id ? s.jobProblems.rows : null;
  return (
    <div className="off-detail">
      <div className="lcd-dim">
        {job.verified_files.toLocaleString()} verified ({formatBytes(job.verified_bytes)}) · copied {formatDate(job.finished_at ?? job.started_at)}
        {job.last_checked_at ? ` · last checked ${formatDate(job.last_checked_at)}${job.last_check_problems ? ` (${job.last_check_problems} problems)` : " (all good)"}` : " · never re-checked"}
        {job.host !== s.catalog?.host ? ` · from ${job.host}` : ""}
      </div>
      {running ? (
        <>
          <ProgressRows progress={running.progress} />
          <div className="off-actions">
            <button type="button" className="chip" onClick={cancelAction}>
              CANCEL
            </button>
          </div>
        </>
      ) : (
        <div className="off-actions">
          <button type="button" className="chip" disabled={busy || !connected} onClick={() => void checkJob(job)} title="Read every copy back from the drive and compare it with what was recorded">
            CHECK
          </button>
          <button type="button" className="chip" disabled={busy || !connected} onClick={() => void restoreJob(job, null, null)} title={`Copy it back to ${job.source_path}. Nothing there is overwritten.`}>
            RESTORE
          </button>
          <button
            type="button"
            className="chip"
            disabled={busy || !connected}
            title="Copy it back into a folder you pick"
            onClick={async () => {
              const to = await pickDirectory();
              if (to) void restoreJob(job, null, to);
            }}
          >
            RESTORE TO…
          </button>
          {left > 0 && job.host === s.catalog?.host ? (
            <>
              <button type="button" className="chip" disabled={busy || !connected || job.source_kind !== "dir"} onClick={() => void releaseJob(job, "trash")} title="Check each copy again, then move the original folder to the Trash">
                TRASH ORIGINALS
              </button>
              <button type="button" className="chip" disabled={busy || !connected} onClick={() => void releaseJob(job, "delete")} title="Check each copy again, then delete its original">
                DELETE ORIGINALS
              </button>
            </>
          ) : null}
          {job.problem_files || job.damaged_files ? (
            <button type="button" className="chip" onClick={() => void showProblems(job.id)}>
              PROBLEMS
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="chip" disabled={busy} onClick={() => void forgetJob(job)} title="Remove this record. Nothing on any disk is touched.">
            FORGET
          </button>
        </div>
      )}
      {!connected ? <div className="lcd-dim">Plug in "{store?.label ?? "its drive"}" to check, restore or remove originals.</div> : null}
      {result ? (
        <div className="off-report">
          <div className={result.good ? "lcd-accent" : "lcd-bad"}>{result.headline}</div>
          {result.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
          <Problems problems={result.problems} total={result.problemsTotal} />
        </div>
      ) : null}
      {rows ? (
        <div className="off-problems">
          {rows.length === 0 ? <div className="lcd-dim">No problems recorded.</div> : null}
          {rows.map((row) => (
            <div key={row.rel_path} className="off-problem" title={row.error ?? ""}>
              <span className="lcd-bad">{row.drive_state && row.drive_state !== "ok" ? row.drive_state : row.state}</span> <span className="lcd-strong">{row.rel_path || "(the folder itself)"}</span>{" "}
              <span className="lcd-dim">{row.error}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DrivesSection({ s }: { s: OffloadState }) {
  const catalog = s.catalog;
  return (
    <div className="off-pane">
      <div className="lcd off-scroll">
        {s.catalogError ? <div className="lcd-bad">Couldn't read the catalog: {s.catalogError}</div> : null}
        {catalog && catalog.stores.length === 0 ? (
          <div className="lcd-dim">Nothing has been offloaded yet. A drive that was filled on another computer, or before this app's data was lost, can be read in with IMPORT.</div>
        ) : null}
        {catalog?.stores.map((store) => {
          const jobs = catalog.jobs.filter((j) => j.store_id === store.id);
          return (
            <div key={store.id} className="off-store">
              <div className="off-store-head" title={store.path ?? `last seen at ${store.last_path} on ${formatDate(store.last_seen_at)}`}>
                <span className="led" data-on={!!store.path} />
                <span className="lcd-strong">{store.label}</span>
                <span className="lcd-dim lcd-ellipsis">{store.path ?? `not connected · last seen ${formatDate(store.last_seen_at)}`}</span>
                <span className="spacer" />
                {store.free_bytes != null ? <span className="lcd-dim">{formatBytes(store.free_bytes)} free</span> : null}
              </div>
              {jobs.length === 0 ? <div className="lcd-dim off-indent">No offloads recorded on it.</div> : null}
              {jobs.map((job) => {
                const badge = jobBadge(job, catalog.host);
                const open = s.selectedJob === job.id;
                return (
                  <div key={job.id} className={`off-job ${open ? "is-open" : ""}`}>
                    <button type="button" className="off-row off-job-head" aria-expanded={open} onClick={() => selectJob(open ? null : job.id)} title={job.source_path}>
                      <span className="section-twisty" aria-hidden>
                        {open ? "▾" : "▸"}
                      </span>
                      <span className="off-name">{job.source_path}</span>
                      <span className={badge.bad ? "lcd-bad" : "lcd-dim"}>{badge.text}</span>
                      <span className="off-size">{formatBytes(job.verified_bytes)}</span>
                    </button>
                    {open ? <JobActions s={s} job={job} store={store} /> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="field-row is-end">
        <button type="button" className="steel-btn" onClick={() => void loadCatalog()} title="Look again for connected drives">
          REFRESH
        </button>
        <button
          type="button"
          className="steel-btn"
          disabled={offloadBusy(s)}
          title="Read the list a drive keeps of what it holds into this app's catalog"
          onClick={async () => {
            const path = await pickDirectory();
            if (path) void importStore(path);
          }}
        >
          IMPORT
        </button>
      </div>
    </div>
  );
}

function FindSection({ s }: { s: OffloadState }) {
  const connected = new Set((s.catalog?.stores ?? []).filter((st) => st.path).map((st) => st.id));
  return (
    <div className="off-pane">
      <div className="field-row">
        <input className="lcd-input" value={s.query} placeholder="part of a file or folder name" onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Find an offloaded file" />
      </div>
      <div className="lcd off-scroll" role="list">
        {s.hits === null ? <div className="lcd-dim">Searches every offload's file list, including drives that aren't plugged in.</div> : null}
        {s.hits?.length === 0 ? <div className="lcd-dim">No offloaded file or folder matches.</div> : null}
        {s.hits?.map((hit) => {
          const original = hit.rel_path ? `${hit.source_path}/${hit.rel_path}` : hit.source_path;
          return (
            <button
              key={`${hit.job_id}:${hit.rel_path}`}
              type="button"
              role="listitem"
              className="off-row off-hit"
              title={`${original}\non "${hit.store_label}"${connected.has(hit.store_id) ? "" : " (not connected)"}`}
              onClick={() => patchOffload({ section: "drives", selectedJob: hit.job_id, jobProblems: null })}
            >
              <span className="library-kind">{hit.kind === "dir" ? "▣" : hit.kind === "symlink" ? "↗" : "·"}</span>
              <span className="off-name">
                {baseName(original)} <span className="lcd-dim">{hit.rel_path ? hit.source_path : ""}</span>
              </span>
              {hit.drive_state && hit.drive_state !== "ok" ? <span className="lcd-bad">{hit.drive_state} on the drive</span> : null}
              <span className={connected.has(hit.store_id) ? "lcd-accent" : "lcd-dim"}>{hit.store_label}</span>
              <span className="lcd-dim">{hit.host !== s.catalog?.host ? `from ${hit.host}` : hit.source_removed ? "drive only" : "also here"}</span>
              <span className="off-size">{hit.kind === "file" ? formatBytes(hit.size) : ""}</span>
            </button>
          );
        })}
        {s.hits && s.hits.length >= 300 ? <div className="lcd-dim">Showing the first 300. Add a word to narrow it down.</div> : null}
      </div>
    </div>
  );
}

export function OffloadWindow({ view, controls }: WindowArgs) {
  const s = useOffload((state) => state);
  const ready = useApp((a) => a.connected === true);
  // The window comes back by itself after a restart: fill it in then, too.
  useEffect(() => {
    if (!ready || !isTauri) return;
    void loadVolumes();
    void loadCatalog();
  }, [ready]);
  const busy = offloadBusy(s);
  const running = s.phase === "running" ? s.progress : (s.action?.progress ?? null);
  const shadeInfo = busy ? `${percent(running)}%` : s.catalog ? `${s.catalog.jobs.length} offloaded` : undefined;
  const section = (id: OffloadSection) => ({
    open: s.section === id,
    onToggle: () => {
      patchOffload({ section: s.section === id ? (id === "move" ? "drives" : "move") : id });
      if (id !== "move") void loadCatalog();
    },
  });

  if (!isTauri) {
    return (
      <Window title="OFFLOAD" view={view} controls={controls} className="kind-offload">
        <div className="tool">
          <div className="lcd lcd-banner">
            <span className="lcd-dim">Offloading is part of the desktop app.</span>
          </div>
        </div>
      </Window>
    );
  }

  const stores = s.catalog?.stores ?? [];
  const removedTotal = (s.catalog?.jobs ?? []).filter((j) => j.host === s.catalog?.host).reduce((sum, j) => sum + j.removed_bytes, 0);
  return (
    <Window title="OFFLOAD" shadeInfo={shadeInfo} view={view} controls={controls} className="kind-offload">
      <div className="tool">
        <div className="field-row">
          <span className={`led ${busy ? "is-busy" : ""}`} data-on={ready} />
          <span className="field-tag off-tag">TO</span>
          <input
            className="lcd-input"
            value={s.dest}
            placeholder="a folder on the external drive"
            onChange={(e) => setDest(e.target.value)}
            spellCheck={false}
            aria-label="Destination on the external drive"
            disabled={busy}
          />
          <button
            type="button"
            className="steel-btn"
            disabled={busy}
            onClick={async () => {
              const picked = await pickDirectory();
              if (picked) setDest(picked);
              void loadVolumes();
            }}
          >
            BROWSE
          </button>
        </div>
        {s.volumes.length || stores.some((st) => st.path) ? (
          <div className="off-chips">
            {stores
              .filter((st) => st.path)
              .map((st) => (
                <button key={st.id} type="button" className={`chip ${s.dest === st.path ? "is-on" : ""}`} disabled={busy} onClick={() => setDest(st.path!)} title={`${st.path}\nused for offloads before`}>
                  ★ {st.label}
                  {st.free_bytes != null ? ` · ${formatBytes(st.free_bytes)} free` : ""}
                </button>
              ))}
            {s.volumes
              .filter((v) => !stores.some((st) => st.path === v.mount))
              .map((v) => (
                <button key={v.mount} type="button" className={`chip ${s.dest === v.mount ? "is-on" : ""}`} disabled={busy} onClick={() => setDest(v.mount)} title={v.mount}>
                  {v.name || v.mount} · {formatBytes(v.free_bytes)} free
                </button>
              ))}
          </div>
        ) : null}
        <Section title="MOVE" info={s.phase === "running" ? "running" : s.candidates.length ? `${s.candidates.length} suggested` : undefined} fill {...section("move")}>
          <MoveSection s={s} />
        </Section>
        <Section title="DRIVES" info={s.catalog ? `${stores.length} · ${formatBytes(removedTotal)} moved off this computer` : undefined} fill {...section("drives")}>
          <DrivesSection s={s} />
        </Section>
        <Section title="FIND" info={s.hits ? s.hits.length : undefined} fill {...section("find")}>
          <FindSection s={s} />
        </Section>
      </div>
    </Window>
  );
}
