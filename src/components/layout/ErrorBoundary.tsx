import { Component, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Empty } from '../ui/primitives';

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
      <div role="alert">
        <Empty
          variant="page"
          icon={<TriangleAlert />}
          title="Something went wrong on this page"
          body="Your work is saved. Try the page again, or go back to the dashboard."
          action={
            <>
              <button type="button" className="btn btn-primary" onClick={() => this.props.onHome?.()}>
                Go to dashboard
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => this.setState({ error: null })}>
                <RefreshCw /> Try again
              </button>
            </>
          }
        />
      </div>
    );
  }
}
