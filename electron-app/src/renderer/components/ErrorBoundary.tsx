import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Custom fallback rendered instead of the default error card. */
  fallback?: ReactNode;
  /** Label shown in the error card header (e.g. "Timeline", "Notes"). */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Wraps a subtree so a thrown render error shows a recovery UI instead of
 * crashing the whole app. Place around Timeline, DictatePage, and
 * MeetingPage — the three heaviest views — so one bad entry or malformed
 * structured-output blob can't blank the entire window.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label ?? 'unknown'}]`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <p className="text-sm font-medium text-red-400">
            {this.props.label ? `${this.props.label} failed to render` : 'Something went wrong'}
          </p>
          <p className="text-xs text-zinc-500 max-w-xs break-words">
            {this.state.error.message}
          </p>
          <button
            onClick={this.handleRetry}
            className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
