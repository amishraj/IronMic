import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** A single text snippet the user has played through the Listen page. Stored
 *  in localStorage so navigating away and back (or restarting the app) doesn't
 *  wipe the history — a deliberate scope choice: Listen is ad-hoc playback,
 *  not first-class content like dictations or notes, so SQLite is overkill. */
export interface ListenEntry {
  id: string;
  text: string;
  createdAt: number;
}

interface ListenStore {
  entries: ListenEntry[];
  addEntry: (text: string) => ListenEntry;
  removeEntry: (id: string) => void;
  clear: () => void;
}

const MAX_ENTRIES = 100;

export const useListenStore = create<ListenStore>()(
  persist(
    (set) => ({
      entries: [],
      addEntry: (text) => {
        const entry: ListenEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          createdAt: Date.now(),
        };
        set((state) => ({
          // Keep newest first; cap to avoid unbounded localStorage growth.
          entries: [entry, ...state.entries].slice(0, MAX_ENTRIES),
        }));
        return entry;
      },
      removeEntry: (id) =>
        set((state) => ({ entries: state.entries.filter((e) => e.id !== id) })),
      clear: () => set({ entries: [] }),
    }),
    {
      name: 'ironmic:listen-entries',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);
