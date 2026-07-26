import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { btn, btnSecondary, dialogBackdrop, dialogPanel, input } from "../ui/classes";
import { Label, Preflight } from "./primitives";
import type { GuardCheck } from "../api/types";

/**
 * The gate in front of an irreversible action.
 *
 * Three things have to be true before the confirm button enables, and each one is defending
 * against a different mistake:
 *
 *  1. The pre-flight has to pass. This is the server's evaluation, shown as pass/fail rather
 *     than prose, so the admin can see *what* is checked and not just that something failed.
 *  2. A phrase has to be typed. Not friction for its own sake — it defeats the muscle memory
 *     that makes a plain "Are you sure?" a single extra click, and it forces the admin to read
 *     which election they are about to act on.
 *  3. An acknowledgement has to be ticked, naming what becomes permanent.
 *
 * None of this is security: the server re-checks the guards and the role on the request. It is
 * there because these operations cannot be undone by anyone, including by a database edit — the
 * ledger already holds the consequence.
 */
export default function ConfirmDialog(props: ConfirmDialogProps) {
  // Mounted only while open, so the typed phrase and the acknowledgement start empty every time
  // by construction. Resetting them in an effect would be the other way to get here, but the
  // phrase names the election — a stale one carried into a second, different confirmation would
  // pre-authorise it.
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  kicker?: string;
  body: ReactNode;
  /** Key/value summary of exactly what is being acted on. */
  facts?: { label: string; value: ReactNode }[];
  checks?: GuardCheck[];
  /** The admin must type this exactly. Shown in the label. */
  confirmPhrase: string;
  acknowledgement: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  actorName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialogBody({
  title,
  kicker = "Irreversible · cannot be undone",
  body,
  facts,
  checks,
  confirmPhrase,
  acknowledgement,
  confirmLabel,
  busy = false,
  error,
  actorName,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const titleId = useId();
  const phraseId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Moving focus into the dialog and listening for Escape are real synchronisations with the DOM,
  // which is what an effect is for.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const guardsPass = !checks || checks.every((check) => check.passed);
  const phraseMatches = typed.trim().toUpperCase() === confirmPhrase.toUpperCase();
  const ready = guardsPass && phraseMatches && acknowledged && !busy;

  return (
    <div
      className={dialogBackdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className={dialogPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <Label accent className="mb-2">
          {kicker}
        </Label>
        <h2 id={titleId} className="text-2xl m-0 mb-2.5">
          {title}
        </h2>
        <div className="text-[13.5px] mb-4">{body}</div>

        {facts && facts.length > 0 ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[12.5px] border-y-2 border-ink/40 py-3 mb-4 m-0">
            {facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="text-ink/55">{fact.label}</dt>
                <dd className="m-0 font-semibold">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {checks && checks.length > 0 ? (
          <div className="mb-4">
            <Label className="mb-2">Pre-flight</Label>
            <Preflight checks={checks} />
          </div>
        ) : null}

        {!guardsPass ? (
          <p className="text-[12.5px] text-accent-700 mb-4">
            One or more checks are failing. This action cannot proceed until they pass.
          </p>
        ) : null}

        <div className="mb-3.5">
          <label htmlFor={phraseId} className="block text-xs text-ink/70 mb-1.5">
            Type <strong className="font-extrabold">{confirmPhrase}</strong> to confirm
          </label>
          <input
            id={phraseId}
            className={`${input} font-mono`}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={!guardsPass || busy}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        <label className="flex items-start gap-2.5 text-[13px] mb-4 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={acknowledged}
            disabled={!guardsPass || busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>{acknowledgement}</span>
        </label>

        {error ? (
          <p className="text-[12.5px] text-accent-800 bg-accent-100 border border-accent-300 px-3.5 py-2.5 mb-4">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <button type="button" className={btn} disabled={!ready} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
          <button type="button" className={btnSecondary} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {actorName ? (
            <span className="ml-auto text-[11.5px] text-ink/55">Logged as {actorName}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
