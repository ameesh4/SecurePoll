import { useRef } from "react";
import type { ReactNode } from "react";
import {
  lb,
  lbAccent,
  statCell,
  statNote,
  statValue,
  tagAccent,
  tagNeutral,
  tagOutline,
} from "../ui/classes";

/**
 * The Modernist system's small parts. Rules and flush-left type do the work here — there are
 * no cards, no rounded corners and no shadows outside the one dialog.
 */

export function Label({
  children,
  accent = false,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  accent?: boolean;
  className?: string;
  /** Use "span" when the label sits inline inside a paragraph — a div there is invalid HTML. */
  as?: "div" | "span";
}) {
  return <Tag className={`${accent ? lbAccent : lb} ${className}`}>{children}</Tag>;
}

/** A label with a 2px rule running out to the right edge. The system's section break. */
export function SectionRule({
  children,
  accent = false,
  action,
}: {
  children: ReactNode;
  accent?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 mb-3.5">
      <Label accent={accent}>{children}</Label>
      <div className={`flex-1 h-0.5 ${accent ? "bg-accent" : "bg-ink/40"}`} />
      {action}
    </div>
  );
}

export type TagTone = "neutral" | "accent" | "outline";

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: TagTone;
}) {
  const className =
    tone === "accent" ? tagAccent : tone === "outline" ? tagOutline : tagNeutral;
  return <span className={className}>{children}</span>;
}

/**
 * A row of statistics divided by hairlines, as on the dashboard and the groups screen. Sized
 * by the number of children rather than a prop so a caller cannot state the wrong count.
 */
export function StatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="grid border-b-2 border-ink/40 [&>*+*]:border-l [&>*+*]:border-ink/40 grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
  accent = false,
  suffix,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  accent?: boolean;
  suffix?: ReactNode;
}) {
  return (
    <div className={statCell}>
      <Label>{label}</Label>
      <div className={`${statValue} ${accent ? "text-accent" : ""}`}>
        {value}
        {suffix ? <span className="text-base font-extrabold opacity-50">{suffix}</span> : null}
      </div>
      {note ? <div className={statNote}>{note}</div> : null}
    </div>
  );
}

/**
 * A pre-flight checklist. Renders exactly what the server returned — the pass/fail is never
 * recomputed here, because the browser recomputing a guard is how a screen ends up promising
 * a transition the server will refuse.
 */
export function Preflight({
  checks,
}: {
  checks: { key: string; label: string; passed: boolean; detail?: string }[];
}) {
  if (checks.length === 0) {
    return <p className="text-[12.5px] text-ink/55 m-0">No preconditions for this step.</p>;
  }

  return (
    <ul className="list-none m-0 p-0 border-2 border-ink/40">
      {checks.map((check, index) => (
        <li
          key={check.key}
          className={`flex gap-2.5 px-3.5 py-3 text-[12.5px] ${
            index < checks.length - 1 ? "border-b border-ink/40" : ""
          }`}
        >
          <span
            aria-hidden
            className={`font-extrabold ${check.passed ? "text-ink" : "text-accent"}`}
          >
            {check.passed ? "✓" : "✗"}
          </span>
          <span>
            <span className="sr-only">{check.passed ? "Passing: " : "Failing: "}</span>
            {check.label}
            {check.detail ? <span className="text-ink/55"> — {check.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Alert({
  tone = "accent",
  title,
  children,
}: {
  tone?: "accent" | "quiet";
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`bg-surface px-4 py-3.5 border-l-[3px] ${
        tone === "accent" ? "border-accent" : "border-ink/40"
      }`}
    >
      {title ? (
        <Label accent={tone === "accent"} className="mb-1.5">
          {title}
        </Label>
      ) : null}
      <div className="text-[12.5px]">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="border-2 border-dashed border-ink/40 px-6 py-8 text-[13px] text-ink/55">
      {children}
    </div>
  );
}

/** Page-level header: kicker, title, and actions pushed to the right. */
export function PageHeader({
  kicker,
  title,
  meta,
  actions,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3.5 px-7 py-5 border-b-2 border-ink/40">
      <div>
        {kicker ? <Label>{kicker}</Label> : null}
        <h1 className="text-[26px] m-0 mt-0.5">{title}</h1>
      </div>
      {meta}
      {actions ? <div className="ml-auto flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * A row checkbox that reports whether shift was held.
 *
 * The shift state is captured on mousedown/keydown rather than read from the change event,
 * because a checkbox's `change` does not reliably carry modifier keys across browsers — and a
 * range-select that silently degrades to a single toggle is worse than not offering one.
 *
 * `disabledReason` becomes the title and the accessible description, so a disabled checkbox
 * always says why. A silently un-clickable control just reads as broken.
 */
export function SelectCheckbox({
  checked,
  onToggle,
  label,
  disabled = false,
  disabledReason,
  className = "",
}: {
  checked: boolean;
  onToggle: (shiftKey: boolean) => void;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}) {
  const shiftHeld = useRef(false);

  return (
    <input
      type="checkbox"
      className={`accent-accent ${disabled ? "cursor-not-allowed" : "cursor-pointer"} ${className}`}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={disabled ? disabledReason : "Shift-click to select a range"}
      onMouseDown={(event) => {
        shiftHeld.current = event.shiftKey;
      }}
      onKeyDown={(event) => {
        shiftHeld.current = event.shiftKey;
      }}
      onChange={() => {
        onToggle(shiftHeld.current);
        shiftHeld.current = false;
      }}
    />
  );
}
