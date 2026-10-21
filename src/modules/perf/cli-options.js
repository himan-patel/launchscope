/** Option helpers shared by `launchscope perf` and `launchscope api`. */

/**
 * Collects a repeatable option into an array.
 *
 * @param {string} value
 * @param {string[] | undefined} previous
 * @returns {string[]}
 */
export const collect = (value, previous) => [...(previous ?? []), value];

/**
 * Keeps only options the user actually passed. Commander gives negatable flags such as
 * `--no-sitemap` an implicit default of true, which would otherwise override config values.
 *
 * @param {import('./settings.js').PerfCliOptions} options
 * @param {import('commander').Command} command
 * @returns {import('./settings.js').PerfCliOptions}
 */
export function onlyExplicitOptions(options, command) {
  return Object.fromEntries(
    Object.entries(options).filter(([name]) => command.getOptionValueSource(name) === 'cli'),
  );
}
