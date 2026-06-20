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
  collectJsonKeys,
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

  constructor(instanceSettings: DataSourceInstanceSettings<MySQLOptions>) {
    super(instanceSettings);
    this.variables = new SQLVariableSupport(this);
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
    const frame = await this.runSql<string[]>(buildTagColumnsQuery(database), { refId: 'tagKeys' });
    // DataFrameView rows are positional: [table_name, column_name, data_type].
    const columns = frame.map((row) => ({ table: row[0], column: row[1], dataType: row[2] }));

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
          const sample = await this.runSql<string[]>(buildJsonKeysSampleQuery(table, column, database, filters), {
            refId: `jsonKeys:${table}.${column}`,
          });
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
    const rows = await this.runSql<string[]>(buildTagValuesQuery(options.key, database, options.filters), {
      refId: 'tagValues',
    });
    return rows.map((row) => ({ text: String(row[0]) }));
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
