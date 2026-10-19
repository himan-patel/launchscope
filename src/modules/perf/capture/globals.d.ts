// Installed in the page by installVitalsObserver().
interface Window {
  __launchscopeVitals(): import('./vitals.js').PageVitals;
}
