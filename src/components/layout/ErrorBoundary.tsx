import { Component, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
  onHome?: () => void;
}

/** Keeps one broken page from blanking the whole workspace. */
export class PageErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel mx-auto mt-10 flex max-w-[520px] flex-col items-center gap-3 p-8 text-center" role="alert">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bad-soft text-bad">
          <TriangleAlert size={22} />
        </span>
        <h2 className="font-display text-[19px] font-semibold">This page hit a snag</h2>
        <p className="text-[13.5px] text-muted">Your work is saved. Try the page again, or head back to the dashboard.</p>
        <div className="mt-1 flex gap-2">
          <button className="btn btn-secondary" onClick={() => this.props.onHome?.()}>
            Dashboard
          </button>
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      </div>
    );
  }
}
