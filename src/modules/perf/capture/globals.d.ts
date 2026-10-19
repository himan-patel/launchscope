// Installed in the page by installVitalsObserver().
interface Window {
  __launchscopeVitals(): import('./vitals.js').PageVitals;
  __launchscopeLastMutation(): number;
  __launchscopeRequests?(): import('./causality.js').TrackedCall[];
}
