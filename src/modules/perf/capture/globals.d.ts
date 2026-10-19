// Installed in the page by installVitalsObserver().
interface Window {
  __launchscopeVitals(): import('./vitals.js').PageVitals;
  __launchscopeInteractivity(): import('./vitals.js').PageInteractivity;
  __launchscopeLastMutation(): number;
  __launchscopeRequests?(): import('./causality.js').TrackedCall[];
}
