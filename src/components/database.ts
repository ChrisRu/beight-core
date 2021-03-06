import { Pool } from 'pg';
import { generateUrl, serialPromise, sleep } from '@/services/util';
import Logger from '@/services/logger';

export class Database {
  pool: Pool;
  connected: boolean;
  logger: Logger;

  constructor() {
    this.connected = false;
    this.pool = new Pool({
      host: process.env.DATABASE_HOST,
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      port: parseInt(process.env.DATABASE_PORT, 10),
      max: 20,
      idleTimeoutMillis: 30000
    });
    this.logger = new Logger('database');
  }

  /**
   * Connect to database
   * @returns Promise that finishes when database is ready
   */
  async connect(): Promise<any> {
    return new Promise(resolve =>
      this.pool.connect(async error => {
        if (error) {
          this.logger.warn(`Can't connect to database: ${error}`);

          return sleep(3000).then(() => {
            this.logger.info('Retrying to connect to database...');
            return this.connect();
          });
        }

        this.connected = true;
        this.logger.info(
          `Connected to database on postgres://${process.env
            .DATABASE_HOST}:${process.env.DATABASE_PORT}`
        );

        return this.createTables(['Account', 'Game', 'Stream']).then(count => {
          const already = count > 0 ? '' : 'already ';
          this.logger.info(`All tables have ${already}been created`);
          resolve();
        });
      })
    );
  }

  /**
   * Execute query to database
   * @param query Query to execute
   * @param data Query data
   * @returns Promise query
   */
  query(query: string, data?: any[]): Promise<any> {
    let newData = data;

    if (!query) {
      this.logger.error(`Query '${query}' is not valid`);
      return Promise.reject(`Query '${query}' is not valid`);
    }

    if (newData && !Array.isArray(newData)) {
      this.logger.warn('Query data is not an array, converting');
      newData = [].concat(data);
    }

    return this.pool.query(query, newData);
  }

  /**
   * Drop a table in the database
   * @param table Table name
   * @returns Promise query
   */
  dropTable(table: string): Promise<any> {
    if (!table) {
      this.logger.error(`Can't drop table: ${table}`);
      return Promise.reject(`Can't drop table: ${table}`);
    }

    const query = `DROP TABLE ${table}`;
    return this.query(query)
      .then(() => {
        this.logger.warn(`Dropped table ${table}`);
      })
      .catch(error => {
        this.logger.error(`Can't drop table: ${error}`);
      });
  }

  /**
   * Update value in the database
   * @param game Game identifier
   * @param stream Stream Identifier
   * @param value Stream value
   * @returns Promise query
   */
  updateValue(game: number, stream: number, value: string): Promise<any> {
    if (!game || !stream) {
      return Promise.reject('Game or stream not supplied');
    }

    const query = `
      INSERT INTO
        stream(value)
        VALUES($1)
        WHERE game = $2
        AND id = $3
    `;

    return this.query(query, [value, game, stream]).catch(error => {
      this.logger.error(`Can't update value: ${error}`);
    });
  }

  /**
   * Create tables if they don't exist
   * @param tables Table names
   * @returns Promise number of tables created
   */
  async createTables(tables: string[]): Promise<number> {
    let createCount = 0;

    const getPromise = (table: string) => (): Promise<any> => {
      if (!table) {
        this.logger.error(`Table '${table}' is not valid`);
        return Promise.reject(`Table '${table}' is not valid`);
      }

      const query = `SELECT to_regclass('${table.toLowerCase()}')`;
      return this.query(query)
        .then(async res => {
          if (res.rows[0].to_regclass === null) {
            createCount++;
            await this[`create${table}Table`]();
          }
        })
        .catch(error => {
          this.logger.error(`Can't execute query: ${error}`);
        });
    };

    this.logger.info("Creating tables if they don't exist");

    await serialPromise((tables || []).map(table => getPromise(table)));

    return createCount;
  }

  /**
   * Create Account Table
   * @returns Promise query
   */
  createAccountTable(): Promise<any> {
    const query = `
      CREATE TABLE account (
        id        serial    PRIMARY KEY,
        username  text      UNIQUE NOT NULL,
        password  text      NOT NULL,
        date      timestamp NOT NULL DEFAULT NOW()
      )
    `;

    return this.query(query)
      .then(() => {
        this.logger.info("Created table 'account' for users");
      })
      .catch(error => {
        this.logger.error(`Can't create table: ${error}`);
      });
  }

  /**
   * Create Game Table
   * @returns Promise query
   */
  createGameTable(): Promise<any> {
    const query = `
      CREATE TABLE game (
        id      serial    PRIMARY KEY,
        account integer   NOT NULL REFERENCES account(id),
        guid    text      UNIQUE NOT NULL,
        date    timestamp NOT NULL DEFAULT NOW()
      )
    `;

    return this.query(query)
      .then(() => {
        this.logger.info("Created table 'game' for games");
      })
      .catch(error => {
        this.logger.error(`Can't create table: ${error}`);
      });
  }

  /**
   * Create Stream Table
   * @returns Promise query
   */
  createStreamTable(): Promise<any> {
    const query = `
      CREATE TABLE stream (
        id        integer   NOT NULL,
        game      integer   NOT NULL REFERENCES game(id),
        language  integer   NOT NULL,
        active    boolean   NOT NULL DEFAULT FALSE,
        player    integer   REFERENCES account(id),
        value     text      NOT NULL,

        PRIMARY KEY(id, game)
      )
    `;

    return this.query(query)
      .then(() => {
        this.logger.info("Created table 'stream' for streams");
      })
      .catch(error => {
        this.logger.error(`Can't create table: ${error}`);
      });
  }

  /**
   * Get the user by username
   * @param username Username of user
   * @returns Promise username of the user if it exists
   */
  findUser(username: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!username) {
        this.logger.error(`Username '${username}' is not valid`);
        reject(`Username '${username}' is not valid`);
      }

      const query =
        'SELECT username FROM account WHERE LOWER(username) = LOWER($1)';
      resolve(this.query(query, [username]));
    });
  }

  /**
   * Find all users that start with username
   * @param username Partial or whole username
   * @returns Promise user
   */
  getUsers(username: string): Promise<any> {
    const query = `
      SELECT username
      FROM users
      WHERE username LIKE '$1%'
    `;

    return this.query(query, [username]).then(data =>
      data.rows.map(user => ({
        username: user.username,
        exact: user.username === username
      }))
    );
  }

  /**
   * Get a new unused GUID
   * @returns New unused GUID
   */
  async getUnusedGuid(): Promise<string> {
    const url = generateUrl(6);
    const query = 'SELECT guid FROM game WHERE guid = $1';

    return this.query(query, [url]).then(data => {
      if (data.rows.length === 0) {
        return url;
      }
      return this.getUnusedGuid();
    });
  }
}

export default new Database();
