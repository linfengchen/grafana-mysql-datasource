import { v4 as uuidv4 } from 'uuid';

import {
  type AdHocVariableFilter,
  type DataSourceGetTagKeysOptions,
  type DataSourceGetTagValuesOptions,
  type DataSourceInstanceSettings,
  type MetricFindValue,
  type ScopedVars,
  type TimeRange,
} from '@grafana/data';
import { CompletionItemKind, type LanguageDefinition, type TableIdentifier } from '@grafana/plugin-ui';
import {
  COMMON_FNS,
  type DB,
  type FuncParameter,
  MACRO_FUNCTIONS,
  type SQLQuery,
  SQLVariableSupport,
  SqlDatasource,
  formatSQL,
} from '@grafana/sql';

import {
  applyAdHocFilters,
  buildJsonAdHocKey,
  buildJsonKeysSampleQuery,
  buildMaxTimeQuery,
  buildTagColumnsQuery,
  buildTagValuesQuery,
  buildTimeColumnQuery,
  collectJsonKeys,
  parseAdHocKey,
  pickTimeColumn,
  shouldProbeForJsonKeys,
} from './adHocFilters';
import { mapFieldsToTypes } from './fields';
import { buildColumnQuery, buildTableQuery, showDatabases } from './mySqlMetaQuery';
import { getSqlCompletionProvider } from './sqlCompletionProvider';
import { quoteIdentifierIfNecessary, quoteLiteral, toRawSql } from './sqlUtil';
import { type MySQLOptions } from './types';

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

/**
 * Serves `key` from `cache` while its entry is younger than `ttlMs`, otherwise
 * runs `load` and stores the promise. Storing the promise rather than the result
 * collapses concurrent callers onto one load; a rejected load is evicted so the
 * next caller retries instead of caching the failure.
 */
function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.value;
  }
  const value = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Maps `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class MySqlDatasource extends SqlDatasource {
  sqlLanguageDefinition: LanguageDefinition | undefined;

  // Caps how many columns are sampled for JSON keys so a wide schema cannot fan
  // out into an unbounded number of probe queries when the filter UI opens.
  private static readonly MAX_JSON_PROBE_COLUMNS = 40;

  // Recent-data window applied to JSON scans when the request carries no time
  // range, so the value/key pickers stay bounded on huge partitioned tables.
  private static readonly DEFAULT_WINDOW_SECONDS = 6 * 3600;

  // How many probe queries may be in flight at once. The cap above bounds the
  // total; this bounds the burst, so opening the filter UI cannot hand the
  // database every probe of a wide schema simultaneously.
  private static readonly JSON_PROBE_CONCURRENCY = 4;

  // How long a resolved key list or time anchor stays usable. Short enough that
  // newly arriving JSON keys show up promptly, long enough that reopening the
  // filter UI does not re-run the whole probe fan-out.
  private static readonly METADATA_TTL_MS = 60_000;

  // Per-table time column ('' = none), resolved lazily from information_schema.
  private readonly timeColumnCache = new Map<string, string>();

  // In-flight and recently resolved time anchors, keyed by database.table.
  private readonly maxTimeCache = new Map<string, CacheEntry<string | undefined>>();

  // In-flight and recently resolved ad hoc key lists. Caching the promise (not
  // just the value) means concurrent callers share one fan-out instead of each
  // starting their own.
  private readonly tagKeysCache = new Map<string, CacheEntry<MetricFindValue[]>>();

  constructor(instanceSettings: DataSourceInstanceSettings<MySQLOptions>) {
    super(instanceSettings);
    this.variables = new SQLVariableSupport(this);
    // Advertise the multi-value ad hoc operators so Grafana shows "is one of"
    // (=|) and "is not one of" (!=|) in the operator dropdown; filterToSql maps
    // them to IN / NOT IN. (Regex operators =~/!~ are shown by Grafana whenever
    // the variable has "Allow custom values" enabled — no plugin flag for those.)
    if (this.meta) {
      this.meta.multiValueFilterOperators = true;
    }
  }

  getQueryModel() {
    return { quoteLiteral };
  }

  // Expands the `$__adHocFilter()` macro using the dashboard's ad hoc filters
  // before the query reaches the backend. `SqlDatasource` drops the `filters`
  // argument that `DataSourceWithBackend.query()` provides, so we reinstate it.
  applyTemplateVariables(target: SQLQuery, scopedVars: ScopedVars, filters?: AdHocVariableFilter[]) {
    const result = super.applyTemplateVariables(target, scopedVars);
    if (result.rawSql) {
      result.rawSql = applyAdHocFilters(result.rawSql, filters);
    }
    return result;
  }

  // Provides the keys used by the ad hoc filter UI. Plain columns are listed as
  // `table.column`. Columns that hold JSON objects (`variant`/`json` types, or
  // text columns storing serialized JSON like `body`) are auto-probed: their
  // top-level keys are sampled and exposed as drillable `table.column["key"]`
  // entries, replacing the bare column (which cannot be DISTINCT-ed directly).
  async getTagKeys(options?: DataSourceGetTagKeysOptions<SQLQuery>): Promise<MetricFindValue[]> {
    const database = this.instanceSettings.jsonData.database;
    const filters = options?.filters;
    const windowSeconds = this.windowSeconds(options?.timeRange);
    // The cascade makes the key list depend on the active filters, so they are
    // part of the identity of a cached result.
    const cacheKey = JSON.stringify([
      database ?? '',
      windowSeconds,
      (filters ?? []).map((f) => [f.key, f.operator, f.value, f.values ?? []]),
    ]);
    return cached(this.tagKeysCache, cacheKey, MySqlDatasource.METADATA_TTL_MS, () =>
      this.loadTagKeys(database, filters, windowSeconds)
    );
  }

  private async loadTagKeys(
    database: string | undefined,
    filters: AdHocVariableFilter[] | undefined,
    windowSeconds: number
  ): Promise<MetricFindValue[]> {
    const frame = await this.runSql<string[]>(buildTagColumnsQuery(database), { refId: 'tagKeys' });
    // DataFrameView rows are positional: [table_name, column_name, data_type].
    const columns = frame.map((row) => ({ table: row[0], column: row[1], dataType: row[2] }));

    // Detect each table's time column from the metadata we already fetched so the
    // JSON key sampling can be bounded to recent partitions.
    const colsByTable = new Map<string, Array<{ name: string; dataType: string }>>();
    for (const { table, column, dataType } of columns) {
      const list = colsByTable.get(table) ?? [];
      list.push({ name: column, dataType: dataType ?? '' });
      colsByTable.set(table, list);
    }
    const timeColumnByTable = new Map<string, string | null>();
    for (const [table, cols] of colsByTable) {
      timeColumnByTable.set(table, pickTimeColumn(cols));
    }

    // Preserve information_schema ordering; the map lets us drop a bare JSON
    // column once we discover drillable keys for it.
    const keys = new Map<string, MetricFindValue>();
    const probes: Array<{ table: string; column: string }> = [];
    for (const { table, column, dataType } of columns) {
      keys.set(`${table}.${column}`, { text: `${table}.${column}` });
      if (shouldProbeForJsonKeys(dataType ?? '')) {
        probes.push({ table, column });
      }
    }

    const probed = probes.slice(0, MySqlDatasource.MAX_JSON_PROBE_COLUMNS);

    // Anchor every probe of a table at one resolved timestamp, so the tables being
    // probed cost one extra metadata query each rather than one per column.
    const maxTimeByTable = new Map<string, string | undefined>();
    await Promise.all(
      Array.from(new Set(probed.map((probe) => probe.table))).map(async (table) => {
        const timeColumn = timeColumnByTable.get(table);
        maxTimeByTable.set(table, timeColumn ? await this.resolveMaxTime(table, timeColumn, database) : undefined);
      })
    );

    const sampled = await mapWithConcurrency(
      probed,
      MySqlDatasource.JSON_PROBE_CONCURRENCY,
      async ({ table, column }) => {
        try {
          const sample = await this.runSql<string[]>(
            buildJsonKeysSampleQuery(table, column, database, filters, {
              timeColumn: timeColumnByTable.get(table) ?? undefined,
              maxTime: maxTimeByTable.get(table),
              windowSeconds,
            }),
            {
              refId: `jsonKeys:${table}.${column}`,
            }
          );
          // Normalize the DataFrameView into positional rows before unioning keys.
          const rows = sample.map((row) => [row[0]]);
          return { table, column, jsonKeys: collectJsonKeys(rows) };
        } catch {
          // A non-JSON or unreadable column — keep its bare `table.column` entry.
          return { table, column, jsonKeys: [] as string[] };
        }
      }
    );

    for (const { table, column, jsonKeys } of sampled) {
      if (jsonKeys.length === 0) {
        continue;
      }
      keys.delete(`${table}.${column}`);
      for (const jsonKey of jsonKeys) {
        const text = buildJsonAdHocKey(table, column, jsonKey);
        keys.set(text, { text });
      }
    }

    return Array.from(keys.values());
  }

  // Provides the distinct values for a selected ad hoc filter key.
  async getTagValues(options: DataSourceGetTagValuesOptions<SQLQuery>): Promise<MetricFindValue[]> {
    const database = this.instanceSettings.jsonData.database;
    const { table } = parseAdHocKey(options.key);
    const timeColumn = table ? await this.resolveTimeColumn(table, database) : undefined;
    const maxTime = table && timeColumn ? await this.resolveMaxTime(table, timeColumn, database) : undefined;
    const rows = await this.runSql<string[]>(
      buildTagValuesQuery(options.key, database, options.filters, {
        timeColumn,
        maxTime,
        windowSeconds: this.windowSeconds(options.timeRange),
      }),
      { refId: 'tagValues' }
    );
    return rows.map((row) => ({ text: String(row[0]) }));
  }

  // Width of the recent-data window for bounding JSON scans: the request's time
  // range when present, otherwise a default. Anchored at the data's own latest
  // timestamp in SQL, so only the width (not the absolute instants) is used here.
  private windowSeconds(timeRange?: TimeRange): number {
    const span = timeRange ? Math.round((timeRange.to.valueOf() - timeRange.from.valueOf()) / 1000) : NaN;
    if (!Number.isFinite(span) || span <= 0) {
      return MySqlDatasource.DEFAULT_WINDOW_SECONDS;
    }
    return Math.max(300, span);
  }

  // Resolves (and caches) a table's latest timestamp, used to anchor the
  // recent-data window. Returns undefined when the table is empty or unreadable,
  // which leaves the scan unbounded rather than bounded at a wrong instant.
  private async resolveMaxTime(table: string, timeColumn: string, database?: string): Promise<string | undefined> {
    const cacheKey = `${database ?? ''}.${table}.${timeColumn}`;
    return cached(this.maxTimeCache, cacheKey, MySqlDatasource.METADATA_TTL_MS, async () => {
      try {
        const frame = await this.runSql<string[]>(buildMaxTimeQuery(table, timeColumn, database), {
          refId: 'tagMaxTime',
        });
        const value = frame[0]?.[0];
        return value ? String(value) : undefined;
      } catch {
        return undefined;
      }
    });
  }

  // Resolves (and caches) a table's datetime column used to bound JSON scans.
  private async resolveTimeColumn(table: string, database?: string): Promise<string | undefined> {
    const cacheKey = `${database ?? ''}.${table}`;
    const cached = this.timeColumnCache.get(cacheKey);
    if (cached !== undefined) {
      return cached || undefined;
    }
    let timeColumn = '';
    try {
      const frame = await this.runSql<string[]>(buildTimeColumnQuery(table, database), { refId: 'tagTimeColumn' });
      const cols = frame.map((row) => ({ name: row[0], dataType: row[1] ?? '' }));
      timeColumn = pickTimeColumn(cols) ?? '';
    } catch {
      timeColumn = '';
    }
    this.timeColumnCache.set(cacheKey, timeColumn);
    return timeColumn || undefined;
  }

  getSqlLanguageDefinition(): LanguageDefinition {
    if (this.sqlLanguageDefinition !== undefined) {
      return this.sqlLanguageDefinition;
    }

    const args = {
      getMeta: (identifier?: TableIdentifier) => this.fetchMeta(identifier),
    };

    this.sqlLanguageDefinition = {
      id: 'mysql',
      completionProvider: getSqlCompletionProvider(args),
      formatter: formatSQL,
    };

    return this.sqlLanguageDefinition;
  }

  async fetchDatasets(): Promise<string[]> {
    const datasets = await this.runSql<string[]>(showDatabases(), { refId: 'datasets' });
    return datasets.map((t) => quoteIdentifierIfNecessary(t[0]));
  }

  async fetchTables(dataset?: string): Promise<string[]> {
    const tables = await this.runSql<string[]>(buildTableQuery(dataset), { refId: 'tables' });
    return tables.map((t) => quoteIdentifierIfNecessary(t[0]));
  }

  async fetchFields(query: Partial<SQLQuery>) {
    if (!query.dataset || !query.table) {
      return [];
    }
    const queryString = buildColumnQuery(query.table, query.dataset);
    const frame = await this.runSql<string[]>(queryString, { refId: `fields-${uuidv4()}` });
    const fields = frame.map((f) => ({
      name: f[0],
      text: f[0],
      value: quoteIdentifierIfNecessary(f[0]),
      type: f[1],
      label: f[0],
    }));
    return mapFieldsToTypes(fields);
  }

  async fetchMeta(identifier?: TableIdentifier) {
    const defaultDB = this.instanceSettings.jsonData.database;
    if (!identifier?.schema && defaultDB) {
      const tables = await this.fetchTables(defaultDB);
      return tables.map((t) => ({ name: t, completion: `${defaultDB}.${t}`, kind: CompletionItemKind.Class }));
    } else if (!identifier?.schema && !defaultDB) {
      const datasets = await this.fetchDatasets();
      return datasets.map((d) => ({ name: d, completion: `${d}.`, kind: CompletionItemKind.Module }));
    } else {
      if (!identifier?.table && (!defaultDB || identifier?.schema)) {
        const tables = await this.fetchTables(identifier?.schema);
        return tables.map((t) => ({ name: t, completion: t, kind: CompletionItemKind.Class }));
      } else if (identifier?.table && identifier.schema) {
        const fields = await this.fetchFields({ dataset: identifier.schema, table: identifier.table });
        return fields.map((t) => ({ name: t.name, completion: t.value, kind: CompletionItemKind.Field }));
      } else {
        return [];
      }
    }
  }

  getFunctions = (): ReturnType<DB['functions']> => {
    const fns = [...COMMON_FNS, { name: 'VARIANCE' }, { name: 'STDDEV' }];

    const columnParam: FuncParameter = {
      name: 'Column',
      required: true,
      options: (query) => this.fetchFields(query),
    };

    return [...MACRO_FUNCTIONS(columnParam), ...fns.map((fn) => ({ ...fn, parameters: [columnParam] }))];
  };

  getDB(): DB {
    if (this.db !== undefined) {
      return this.db;
    }

    return {
      datasets: () => this.fetchDatasets(),
      tables: (dataset?: string) => this.fetchTables(dataset),
      fields: (query: SQLQuery) => this.fetchFields(query),
      validateQuery: (query: SQLQuery, _range?: TimeRange) =>
        Promise.resolve({ query, error: '', isError: false, isValid: true }),
      toRawSql,
      functions: () => this.getFunctions(),
      getEditorLanguageDefinition: () => this.getSqlLanguageDefinition(),
    };
  }
}
