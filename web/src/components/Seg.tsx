import { btnSecondary } from "../ui/classes";

export interface SegOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * The system's segmented control: one bordered strip, hairlines between options, the selected
 * one filled with the accent.
 *
 * Built from radio inputs rather than buttons so it is a single tab stop with arrow-key
 * movement between options, which is what a filter this dense should behave like.
 */
export function Seg<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled = false,
}: {
  name: string;
  value: T;
  options: readonly SegOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex border border-ink/40" role="group">
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] cursor-pointer ${
              index > 0 ? "border-l border-ink/40" : ""
            } ${
              selected ? "bg-accent text-bg font-semibold" : "hover:bg-ink/7"
            } ${disabled ? "opacity-45 cursor-not-allowed" : ""} focus-within:outline-2 focus-within:outline-accent focus-within:-outline-offset-2`}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            {option.label}
            {option.count === undefined ? null : (
              <span className={selected ? "opacity-80" : "text-ink/55"}>{option.count}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  hint,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  hint?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center gap-2 pt-4">
      <span className="text-[11.5px] text-ink/55">
        {total === 0 ? "Nothing to show" : `${first}–${last} of ${total}`}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {hint ? <span className="text-[11px] text-ink/55">{hint}</span> : null}
        <button
          type="button"
          className={btnSecondary}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={btnSecondary}
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
