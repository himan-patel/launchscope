/**
 * Check modules are the unit of extension in LaunchScope. Each module owns one area of launch
 * readiness, registers its own subcommand (`launchscope <id> ...`), validates its own config
 * section (`config.<id>`), and writes into its own folder inside the run directory.
 *
 * Modules that are not built yet stay listed here so `launchscope modules` doubles as a
 * public roadmap. See docs/architecture.md for the full contract.
 */

/** @typedef {'available' | 'in-progress' | 'planned'} ModuleStatus */

/**
 * Shared services handed to every module when it registers its command.
 *
 * @typedef {object} ModuleServices
 * @property {(command: import('commander').Command) => Promise<import('../runtime.js').Runtime>} resolveRuntime
 *   Builds the runtime (logger, config, output settings) for the command being executed.
 */

/**
 * @typedef {object} CheckModule
 * @property {string} id Subcommand name and config section key.
 * @property {string} title
 * @property {string} summary
 * @property {ModuleStatus} status
 * @property {(program: import('commander').Command, services: ModuleServices) => void} [register]
 *   Adds the module's subcommand. Omitted until the module ships.
 */

/** @type {readonly CheckModule[]} */
export const CHECK_MODULES = Object.freeze([
  {
    id: 'perf',
    title: 'Performance',
    status: 'in-progress',
    summary:
      'Trace every route and API hop, measure real timings and payload sizes, find bottlenecks, and stress test.',
  },
  {
    id: 'seo',
    title: 'SEO & sharing',
    status: 'planned',
    summary:
      'Meta and Open Graph tags, sitemap and robots.txt, canonical URLs, structured data, stray noindex.',
  },
  {
    id: 'security',
    title: 'Security',
    status: 'planned',
    summary: 'Security headers, TLS and certificates, exposed files, cookie flags, mixed content.',
  },
  {
    id: 'a11y',
    title: 'Accessibility',
    status: 'planned',
    summary: 'Automated WCAG checks on every route, plus keyboard and contrast issues.',
  },
  {
    id: 'compliance',
    title: 'Privacy & compliance',
    status: 'planned',
    summary: 'Privacy and terms pages, consent before tracking, third-party data flows.',
  },
  {
    id: 'domain',
    title: 'Domain & email',
    status: 'planned',
    summary: 'SPF, DKIM, and DMARC records, DNS health, domain and certificate expiry.',
  },
]);
