import { useToastStore, type Toast as ToastItem } from '../stores/useToastStore';
import { AlertCircle, CheckCircle, Info, X } from 'lucide-react';

const icons = {
  error: AlertCircle,
  info: Info,
  success: CheckCircle,
};

const styles = {
  error: 'bg-iron-danger/10 border-iron-danger/30 text-iron-danger',
  info: 'bg-iron-accent/10 border-iron-accent/30 text-iron-accent-light',
  success: 'bg-iron-success/10 border-iron-success/30 text-iron-success',
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = icons[toast.type];

  return (
    <div
      className={`flex items-start gap-2.5 px-3.5 py-3 rounded-xl border shadow-lg backdrop-blur-sm animate-slide-in ${styles[toast.type]}`}
    >
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium leading-relaxed">{toast.message}</p>
        {toast.action && (
          <button
            onClick={() => {
              toast.action!.onClick();
              dismiss(toast.id);
            }}
            className="mt-1.5 text-[11px] font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
