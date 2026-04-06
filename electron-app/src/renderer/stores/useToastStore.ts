import { create } from 'zustand';

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'info' | 'success';
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastStore {
  toasts: Toast[];
  show: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: (toast) => {
    const id = `toast-${++nextId}`;
    const entry = { ...toast, id };
    set({ toasts: [...get().toasts, entry] });

    const duration = toast.durationMs ?? (toast.type === 'error' ? 8000 : 4000);
    setTimeout(() => get().dismiss(id), duration);
  },

  dismiss: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
