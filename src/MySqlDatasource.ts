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

export class MySqlDatasource extends SqlDatasource {
  sqlLanguageDefinition: LanguageDefinition | undefined;

  // Caps how many columns are sampled for JSON keys so a wide schema cannot fan
  // out into an unbounded number of probe queries when the filter UI opens.
  private static readonly MAX_JSON_PROBE_COLUMNS = 40;

  // Recent-data window applied to JSON scans when the request carries no time
  // range, so the value/key pickers stay bounded on huge partitioned tables.
  private static readonly DEFAULT_WINDOW_SECONDS = 6 * 3600;

  // Per-table time column ('' = none), resolved lazily from information_schema.
  private readonly timeColumnCache = new Map<string, string>();

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

    const sampled = await Promise.all(
      probes.slice(0, MySqlDatasource.MAX_JSON_PROBE_COLUMNS).map(async ({ table, column }) => {
        try {
          const sample = await this.runSql<string[]>(
            buildJsonKeysSampleQuery(table, column, database, filters, {
              timeColumn: timeColumnByTable.get(table) ?? undefined,
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
      })
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
    const rows = await this.runSql<string[]>(
      buildTagValuesQuery(options.key, database, options.filters, {
        timeColumn,
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
