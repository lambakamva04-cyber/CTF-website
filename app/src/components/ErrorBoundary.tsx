import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence: a render crash inside the dashboard must not leave a
 * client staring at a blank white page while a call is ringing.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Dashboard crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-white text-black font-body flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-4">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="text-sm text-gray-500">
            The dashboard hit an unexpected error. Reloading usually clears it. Your calls and
            bookings are unaffected.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-black text-white rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-gray-800 transition"
          >
            Reload dashboard
          </button>
        </div>
      </div>
    );
  }
}
