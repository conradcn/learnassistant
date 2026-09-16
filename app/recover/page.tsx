// FRACTAL: implements F5 | component C10
"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RecoveryInfo } from "@/shapes";
import { getRecoveryInfo, restorePreviousCopy } from "@/ui/api-client";

type Outcome =
  | { status: "idle" }
  | { status: "restored" }
  | { status: "no-previous" }
  | { status: "failed"; message: string };

export default function RecoverPage(): ReactNode {
  const [info, setInfo] = useState<RecoveryInfo | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ status: "idle" });

  useEffect(() => {
    void getRecoveryInfo().then((response) => {
      if (response.ok) setInfo(response.data);
    });
  }, []);

  const restore = useCallback((): void => {
    setOutcome({ status: "idle" });
    void restorePreviousCopy().then((response) => {
      if (!response.ok) {
        setOutcome({ status: "failed", message: response.error.message });
        return;
      }
      setOutcome(
        response.data.restored
          ? { status: "restored" }
          : { status: "no-previous" },
      );
    });
  }, []);

  return (
    <div className="la-recover">
      {/* WHY: with the store down every other route answers 503, so the app-wide nav would
          offer five ways back into the failure and compete with the one control that works.
          The nav lives in the root layout, which this segment cannot replace, so globals.css
          hides it for as long as this screen is on the page (`body:has(.la-recover)`). */}
      <section className="la-card" data-testid="recover-page">
        <h1>Your saved learning couldn&apos;t be opened</h1>
        <p>
          The file that holds your subjects, lessons and reviews is called{" "}
          <code>{info?.dataFileName ?? "learn.db"}</code> and it lives in this
          folder on your computer. Something about it is unreadable right now,
          so nothing is being shown rather than showing you an empty screen.
        </p>
        {info === null ? null : (
          <pre data-testid="recover-data-root">
            <code>{info.dataRoot}</code>
          </pre>
        )}
        <p>
          We keep the previous copy of that file next to it, named{" "}
          <code>{info?.backupFileName ?? "learn.db.v*.prev"}</code>. Putting it
          back usually fixes this. You may lose the most recent few minutes of
          work, and nothing else.
        </p>
        <button
          type="button"
          className="la-primary"
          onClick={restore}
          data-testid="restore-button"
        >
          Use the previous copy
        </button>
        {outcome.status === "restored" ? (
          <p role="status" data-testid="recover-restored">
            Done — the previous copy is back in place.{" "}
            <Link href="/">Go back to your subjects</Link>
          </p>
        ) : null}
        {outcome.status === "no-previous" ? (
          <p role="status" data-testid="recover-none">
            There was no previous copy to put back. You can start again with a
            fresh, empty set of subjects, or move the folder somewhere safe
            first if you want to keep it.
          </p>
        ) : null}
        {outcome.status === "failed" ? (
          <p role="alert" data-testid="recover-failed">
            {outcome.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
