import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UsageError } from './errors.js';

export const CONFIG_FILENAME = 'launchscope.config.json';

/**
 * @typedef {{ [key: string]: unknown }} ConfigObject
 *
 * @typedef {object} LoadedConfig
 * @property {string | null} path Absolute path of the file that was loaded, if any.
 * @property {ConfigObject} values Parsed configuration with `${ENV_VAR}` references resolved.
 */

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Loads `launchscope.config.json`.
 *
 * With an explicit path the file must exist. Without one, the file is optional and looked up
 * in `cwd`. String values may reference environment variables as `${NAME}` so secrets such as
 * auth headers stay out of the file itself.
 *
 * Only the shared top-level shape is validated here; each module validates its own section.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {Record<string, string | undefined>} options.env
 * @param {string} [options.explicitPath]
 * @returns {Promise<LoadedConfig>}
 */
export async function loadConfig({ cwd, env, explicitPath }) {
  const path = resolve(cwd, explicitPath ?? CONFIG_FILENAME);

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') && explicitPath === undefined) {
      return { path: null, values: {} };
    }
    throw new UsageError(`Could not read config file ${path}.`, { cause: error });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Config file ${path} is not valid JSON: ${detail}`, { cause: error });
  }

  if (!isPlainObject(parsed)) {
    throw new UsageError(`Config file ${path} must contain a JSON object at the top level.`);
  }

  validateTopLevel(parsed, path);
  return { path, values: /** @type {ConfigObject} */ (interpolateEnv(parsed, env, path)) };
}

/**
 * @param {ConfigObject} config
 * @param {string} path
 */
function validateTopLevel(config, path) {
  for (const [key, value] of Object.entries(config)) {
    if (key === '$schema' || key === 'outputDir') {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new UsageError(`"${key}" in ${path} must be a non-empty string.`);
      }
      continue;
    }
    if (!isPlainObject(value)) {
      throw new UsageError(
        `"${key}" in ${path} must be an object (module sections hold their own settings).`,
      );
    }
  }
}

/**
 * Resolves `${NAME}` references. A missing variable is an error rather than an empty string,
 * so a misconfigured secret never silently becomes a blank header. Values are never echoed.
 *
 * @param {unknown} value
 * @param {Record<string, string | undefined>} env
 * @param {string} path
 * @returns {unknown}
 */
function interpolateEnv(value, env, path) {
  if (typeof value === 'string') {
    return value.replace(ENV_REFERENCE, (_match, name) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new UsageError(`Config file ${path} references \${${name}}, which is not set.`, {
          hint: `Set the ${name} environment variable or remove the reference.`,
        });
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnv(item, env, path));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env, path)]),
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is ConfigObject}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrnoCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
