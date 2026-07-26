import { useCallback, useMemo, useState } from "react";

const NOTHING: ReadonlySet<string> = new Set();

export interface Selection {
  /** Ids currently selected, scoped to the current view. */
  ids: ReadonlySet<string>;
  count: number;
  has: (id: string) => boolean;
  /** Toggle one row. Pass `shiftKey` to extend from the last row touched. */
  toggle: (id: string, shiftKey?: boolean) => void;
  /** Select or clear every selectable row on the page. */
  toggleAll: () => void;
  allSelected: boolean;
  clear: () => void;
  /** True when every selectable row on the page is selected and there is at least one. */
  set: (ids: Iterable<string>) => void;
}

/**
 * Multi-select for a paginated list.
 *
 * Two things here are deliberate rather than incidental.
 *
 * **The selection is tagged with the view it was made in.** A batch chosen under one filter must
 * not survive into another, because the admin would then be one click away from approving records
 * they can no longer see. Comparing the tag during render discards a stale selection without an
 * effect, so there is no cascading re-render and no window in which the old set is live.
 *
 * **Shift-click extends a range.** This is not a nicety for a screen whose whole purpose is
 * transferring hundreds of voters at a time: without it, "select these 200" is 200 clicks, and an
 * admin doing that will instead reach for select-all and then hunt for the ones to remove — which
 * is the error-prone direction.
 *
 * `selectableIds` must be the ids the user is actually allowed to pick, in the order they are
 * displayed; ranges and select-all are both defined against it.
 */
export function useSelection(view: string, selectableIds: readonly string[]): Selection {
  const [state, setState] = useState<{ view: string; ids: ReadonlySet<string> }>({
    view,
    ids: NOTHING,
  });
  // The last row the user touched, so a subsequent shift-click knows where the range starts.
  const [anchor, setAnchor] = useState<{ view: string; id: string } | null>(null);

  const ids = state.view === view ? state.ids : NOTHING;

  const write = useCallback(
    (next: ReadonlySet<string>) => setState({ view, ids: next }),
    [view],
  );

  const selectable = useMemo(() => selectableIds, [selectableIds]);

  const toggle = useCallback(
    (id: string, shiftKey = false) => {
      const anchorId = anchor?.view === view ? anchor.id : null;
      const next = new Set(ids);

      if (shiftKey && anchorId && anchorId !== id) {
        const from = selectable.indexOf(anchorId);
        const to = selectable.indexOf(id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          // The range takes the state of the row being clicked, matching how file lists behave:
          // shift-clicking an unselected row selects the span, shift-clicking a selected one
          // clears it.
          const selecting = !ids.has(id);
          for (const between of selectable.slice(start, end + 1)) {
            if (selecting) next.add(between);
            else next.delete(between);
          }
          write(next);
          setAnchor({ view, id });
          return;
        }
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      write(next);
      setAnchor({ view, id });
    },
    [anchor, ids, selectable, view, write],
  );

  const allSelected = selectable.length > 0 && selectable.every((id) => ids.has(id));

  const toggleAll = useCallback(() => {
    write(allSelected ? NOTHING : new Set(selectable));
    setAnchor(null);
  }, [allSelected, selectable, write]);

  const clear = useCallback(() => {
    write(NOTHING);
    setAnchor(null);
  }, [write]);

  const set = useCallback((next: Iterable<string>) => write(new Set(next)), [write]);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  return { ids, count: ids.size, has, toggle, toggleAll, allSelected, clear, set };
}
