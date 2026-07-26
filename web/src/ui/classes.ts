/** Shared Tailwind class strings so buttons and fields stay consistent. */

export const btn =
  "inline-flex items-center justify-center gap-1.5 cursor-pointer font-sans font-extrabold text-sm leading-tight px-3.5 py-2 border border-transparent bg-accent text-bg hover:bg-accent-600 active:bg-accent-700 disabled:opacity-45 disabled:cursor-not-allowed";

export const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 cursor-pointer font-sans font-extrabold text-sm leading-tight px-3.5 py-2 border border-ink/40 bg-transparent text-ink hover:bg-ink/7 active:bg-ink/14 disabled:opacity-45 disabled:cursor-not-allowed";

export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 cursor-pointer font-sans font-extrabold text-sm leading-tight px-3.5 py-2 border border-transparent bg-accent-800 text-bg hover:bg-accent-900 disabled:opacity-45 disabled:cursor-not-allowed";

export const field = "flex flex-col gap-1.5";

export const label =
  "block text-xs font-semibold text-ink/70";

export const input =
  "w-full min-h-9 px-2.5 py-1.5 text-sm text-ink caret-accent bg-surface border border-ink/40 hover:border-ink/45 focus:border-accent focus:outline-none aria-[invalid=true]:border-accent-700";

export const textarea =
  "w-full min-h-[90px] px-2.5 py-1.5 text-sm text-ink caret-accent bg-surface border border-ink/40 resize-y hover:border-ink/45 focus:border-accent focus:outline-none";

export const card = "flex flex-col gap-2 bg-surface p-4";

export const alertError =
  "px-3.5 py-2.5 text-sm bg-accent-100 border border-accent-300 text-accent-800";

export const alertSuccess =
  "px-3.5 py-2.5 text-sm bg-neutral-100 border border-neutral-300 text-neutral-800";

export const alertWarning =
  "px-3.5 py-2.5 text-sm bg-accent-100 border border-accent-200 text-accent-800";

export const hint = "text-[0.8rem] text-ink/50";

export const errorText = "text-[0.8rem] text-accent-700";

export const mono = "font-mono text-[0.82rem] break-all";

export const srOnly =
  "absolute w-px h-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]";

/* ── Modernist structure ───────────────────────────────────────────────────────────────── */

/**
 * The system is carried by rules and flush-left type rather than by cards and shadows: 2px
 * dividers for structural breaks, 1px inside a group, zero radius everywhere. These strings
 * are the shared vocabulary for that so the screens do not each re-invent it.
 */

/** Small uppercase label — the system's workhorse for naming a region. */
export const lb =
  "text-[10px] font-extrabold tracking-[0.1em] uppercase text-ink/50";

export const lbAccent =
  "text-[10px] font-extrabold tracking-[0.1em] uppercase text-accent-700";

export const rule = "h-0.5 bg-ink/40";
export const ruleThin = "h-px bg-ink/40";

export const borderStrong = "border-ink/40";

/** Section heading: a label with a rule running to the right edge. */
export const sectionRow = "flex items-baseline gap-3 mb-3.5";

export const btnGhost =
  "inline-flex items-center justify-center gap-1.5 cursor-pointer font-sans font-extrabold text-sm leading-tight px-1 py-1 bg-transparent text-accent hover:bg-accent/10 active:bg-accent/20 disabled:opacity-45 disabled:cursor-not-allowed";

/** Cell in a divided statistic strip. */
export const statCell = "px-6 py-5";
export const statLabel = lb;
export const statValue = "font-extrabold text-4xl leading-[1.1] tabular-nums";
export const statNote = "text-[11.5px] text-ink/55";

export const tableWrap = "w-full overflow-x-auto";
export const table = "w-full border-collapse text-sm";
export const th =
  "text-left text-[11px] font-semibold tracking-[0.08em] uppercase text-ink/60 px-2 py-2 border-b-2 border-ink/40";
export const td = "px-2 py-2 border-b border-ink/40 align-top";

export const tagNeutral =
  "inline-flex items-center text-[11px] px-2.5 py-0.5 bg-neutral-100 text-neutral-800";
export const tagAccent =
  "inline-flex items-center text-[11px] px-2.5 py-0.5 bg-accent-100 text-accent-800";
export const tagOutline =
  "inline-flex items-center text-[11px] px-2.5 py-0.5 border border-accent text-accent";

/**
 * The system's way of marking something that needs attention: a surface panel with an accent
 * rule down its left edge. Used for duplicate warnings and irreversible-action notices.
 */
export const notice = "bg-surface border-l-[3px] border-accent px-4 py-3.5";
export const noticeQuiet = "bg-surface border-l-[3px] border-ink/40 px-4 py-3.5";

export const dialogBackdrop =
  "fixed inset-0 z-50 grid place-items-center p-6 bg-neutral-900/55";
export const dialogPanel =
  "w-full max-w-[540px] bg-surface shadow-[0_12px_32px_rgba(45,43,43,0.22)] px-7 py-6 max-h-[90vh] overflow-y-auto";
