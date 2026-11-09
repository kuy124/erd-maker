import type { WebsocketProvider } from 'y-websocket';

export function limitRelayRetries(relay: WebsocketProvider): (reset?: boolean) => void {
  let stopped = false;
  const previous = relay.shouldReconnect;
  relay.shouldReconnect = (event, provider) => {
    // The provider increments this counter before asking whether to retry.
    stopped = !previous(event, provider) || provider.wsUnsuccessfulReconnects >= 5;
    return !stopped;
  };
  return (reset = false) => {
    if (reset) {
      stopped = false;
      relay.wsUnsuccessfulReconnects = 0;
    }
    if (stopped) return;
    if (!relay.wsconnected && !relay.wsconnecting) relay.connect();
  };
}
