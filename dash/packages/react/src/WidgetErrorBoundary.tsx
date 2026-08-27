import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@freebirdai/dash-components";

/**
 * One broken widget must not take the board with it.
 *
 * There was no boundary anywhere in this app, and the consequence is on
 * record: `ChatBody` called `useDashboard()` outside a provider, the hook
 * threw by design, and React unmounted the entire tree — a blank page from a
 * panel that had nothing to do with the dashboard.
 *
 * A class component because this is the one thing hooks still cannot do.
 */
interface Props {
  readonly children: ReactNode;
  /** Named in the message, so the person knows which tile to go and fix. */
  readonly widgetTitle: string;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  readonly error: Error | null;
}

export class WidgetErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * Logged as well as rendered. The card tells the user something broke; the
     * console is the only place the stack survives, and a component crash is
     * a defect rather than a state the data can be in.
     */
    console.error(`Widget "${this.props.widgetTitle}" crashed while rendering.`, error, info);
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ErrorState
        message="This widget could not be drawn."
        // The message is the useful part of a render crash, and hiding it
        // behind a console the user will not open helps nobody.
        detail={[error.message]}
        onRetry={this.retry}
        retryLabel="Try drawing it again"
      />
    );
  }
}
