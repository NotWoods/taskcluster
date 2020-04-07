const buffer = require('buffered-async-iterator');
const { Table, Blob } = require('fast-azure-storage');
const prettyMilliseconds = require('pretty-ms');
const glob = require('glob');
const {postgresTableName} = require('taskcluster-lib-entities');
const {REPO_ROOT, readRepoYAML} = require('../utils');
const { readAzureTableInChunks, writeToPostgres, ALLOWED_TABLES, LARGE_TABLES } = require('./util');

const importer = async options => {
  const { credentials, db } = options;
  const tasks = [];

  let tables = [];
  for (let path of glob.sync('services/*/azure.yml', {cwd: REPO_ROOT})) {
    const azureYml = await readRepoYAML(path);
    for (let t of azureYml.tables || []) {
      if (ALLOWED_TABLES.includes(t)) {
        tables.push(t);
      }
    }
  }

  async function importTable(tableName, tableParameters = {}, rowsProcessed = 0, utils) {
    for await (let result of buffer(
      readAzureTableInChunks({
        azureCreds: credentials.azure,
        tableName,
        utils,
        tableParams: tableParameters,
        rowsProcessed,
      }),
      5,
    )) {
      const { entities, count } = result;

      await writeToPostgres(tableName, entities, db, ALLOWED_TABLES);

      rowsProcessed = count;
    }

    return rowsProcessed;
  }

  async function importRoles(tableName, utils) {
    // These are not currently used by the azure-blob-storage library
    const container = new Blob(credentials.azure);
    let blobInfo = await container.getBlob('auth-production-roles', 'Roles', {});
    let {content: blobContent} = blobInfo;
    let {content: roles} = JSON.parse(blobContent);

    // this is a little tricky, but we *manully* create a single "entity" that can be imported
    // into postgres
    const entity = {
      RowKey: 'role',
      PartitionKey: 'role',
      __bufchunks_blob: 1,
      __buf0_blob: Buffer.from(JSON.stringify(roles)).toString('base64'),
    };

    await writeToPostgres(tableName, [entity], db, ALLOWED_TABLES);

    return 1;
  }

  let largeTableNames = [];
  for (let tableName of tables) {
    if (LARGE_TABLES.includes(tableName)) {
      const pgTable = postgresTableName(tableName);

      await db._withClient('admin', async client => {
        await client.query(`truncate ${pgTable}`);
      });
      const may2020 = new Date(2020, 4, 1);
      const july2020 = new Date(2020, 6, 1);
      const september2020 = new Date(2020, 8, 1);
      const november2020 = new Date(2020, 10, 1);
      const january2021 = new Date(2020, 12, 1);

      [
        {
          name: `${tableName}-1/6`,
          filter: `expires ${Table.Operators.LessThan} ${Table.Operators.date(may2020)}`,
          title: `expires < ${may2020.toJSON()}`,
        },
        {
          name: `${tableName}-2/6`,
          filter: `expires ${Table.Operators.GreaterThanOrEqual} ${Table.Operators.date(may2020)} ${Table.Operators.And} expires ${Table.Operators.LessThan} ${Table.Operators.date(july2020)}`,
          title: `expires >= ${may2020.toJSON()} and < ${july2020.toJSON()}`,
        },
        {
          name: `${tableName}-3/6`,
          filter: `expires ${Table.Operators.GreaterThanOrEqual} ${Table.Operators.date(july2020)} ${Table.Operators.And} expires ${Table.Operators.LessThan} ${Table.Operators.date(september2020)}`,
          title: `expires >= ${july2020.toJSON()} and < ${september2020.toJSON()}`,
        },
        {
          name: `${tableName}-4/6`,
          filter: `expires ${Table.Operators.GreaterThanOrEqual} ${Table.Operators.date(september2020)} ${Table.Operators.And} expires ${Table.Operators.LessThan} ${Table.Operators.date(november2020)}`,
          title: `expires >= ${september2020.toJSON()} and < ${november2020.toJSON()}`,
        },
        {
          name: `${tableName}-5/6`,
          filter: `expires ${Table.Operators.GreaterThanOrEqual} ${Table.Operators.date(november2020)} ${Table.Operators.And} expires ${Table.Operators.LessThan} ${Table.Operators.date(january2021)}`,
          title: `expires >= ${november2020.toJSON()} and < ${january2021.toJSON()}`,
        },
        {
          name: `${tableName}-6/6`,
          filter: `expires ${Table.Operators.GreaterThanOrEqual} ${Table.Operators.date(january2021)}`,
          title: `expires >= ${january2021.toJSON()}`,
        },
      ].forEach(({ name, filter, title }) => {
        largeTableNames.push(name);
        tasks.push({
          title: `Import Table ${tableName} (${title})`,
          locks: ['concurrency'],
          requires: [],
          provides: [name],
          run: async (requirements, utils) => {
            const start = new Date();

            const rowsImported = await importTable(tableName, { filter }, 0, utils);

            return {
              [name]: {
                elapsedTime: new Date() - start,
                rowsImported,
              },
            };
          },
        });
      });
    } else {
      tasks.push({
        title: `Import Table ${tableName}`,
        locks: ['concurrency'],
        requires: [],
        provides: [tableName],
        run: async (requirements, utils) => {
          const start = new Date();

          const pgTable = postgresTableName(tableName);

          await db._withClient('admin', async client => {
            await client.query(`truncate ${pgTable}`);
          });

          const rowsImported = await importTable(tableName, {}, 0, utils);

          return {
            [tableName]: {
              elapsedTime: new Date() - start,
              rowsImported,
            },
          };
        },
      });
    }
  }

  tasks.push({
    title: `Import Container Roles`,
    locks: ['concurrency'],
    requires: [],
    provides: ['roles'],
    run: async (requirements, utils) => {
      const start = new Date();

      const tableName = 'Roles';
      const pgTable = postgresTableName(tableName);

      await db._withClient('admin', async client => {
        await client.query(`truncate ${pgTable}`);
      });

      const rowsImported = await importRoles(tableName, utils);

      return {
        'roles': {
          elapsedTime: new Date() - start,
          rowsImported,
        },
      };
    },
  });

  tasks.push({
    title: 'Importer Metadata',
    requires: [
      ...tables.filter(tableName => !LARGE_TABLES.includes(tableName)),
      ...largeTableNames,
      'roles',
    ],
    provides: ['metadata'],
    run: async (requirements, utils) => {
      const total = {
        rowsImported: 0,
        elapsedTime: 0,
      };
      const prettify = (header, rowsImported, elapsedTime) => {
        return [
          `--- ${header} ---`,
          `Rows imported: ${rowsImported}`,
          elapsedTime ? `Elapsed time: ${prettyMilliseconds(elapsedTime)}` : null,
          '',
        ].filter(Boolean).join('\n');
      };
      const tablesMetadata = Object.entries(requirements).map(([tableName, { rowsImported, elapsedTime }]) => {
        total.rowsImported += rowsImported;
        total.elapsedTime += elapsedTime;

        return prettify(tableName, rowsImported, elapsedTime);
      }).join('\n');
      const totalMetadata = prettify('Summary', total.rowsImported);

      return {
        metadata: [totalMetadata, tablesMetadata].join('\n'),
      };
    },
  });

  return tasks;
};

module.exports = importer;