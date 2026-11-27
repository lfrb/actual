import type { Query } from '@actual-app/core/shared/query';
import type { TransactionEntity } from '@actual-app/core/types/models';

import { aqlQuery } from './aqlQuery';
import { LiveQuery } from './liveQuery';

const REGISTER_ROW_FIELDS = [
  'id',
  'parent_id',
  'reconciled',
  'is_parent',
  'is_child',
  'account',
  'date',
  'amount',
  'payee',
  'transfer_id',
  'schedule',
] as const satisfies readonly (keyof TransactionEntity)[];

export type RegisterRow = Pick<
  TransactionEntity,
  // The grouped query supplies _unmatched alongside the selected fields.
  (typeof REGISTER_ROW_FIELDS)[number] | '_unmatched'
>;

type RegisterGroup = RegisterRow & { subtransactions: RegisterRow[] };

const PAGE_SIZE = 150;
const CACHE_PAGES = 10;

// Keep a lightweight index in query order for selection and split expansion.
// Cache full transaction groups in a sparse map keyed by page number. A jump
// can load the destination page directly. The inherited data array contains
// only the groups in cached pages, in query order.
export class RegisterQuery extends LiveQuery<TransactionEntity> {
  groups: RegisterGroup[] = [];
  rows: RegisterRow[] = [];
  private groupIndex = new Map<string, number>();
  private pages = new Map<number, TransactionEntity[]>();
  private pending = new Map<number, Promise<void>>();
  private refreshing = false;
  private loadingRange = false;
  private rangeVersion = 0;
  private generation = 0;
  private wanted = [0];

  constructor(query: Query, onData: (data: TransactionEntity[]) => void) {
    super(query, onData, undefined, { onlySync: true });
  }

  // Rebuild the index and reload the requested pages after a refresh.
  run = () => {
    this.subscribe();
    const generation = ++this.generation;
    this.refreshing = true;
    this.pending.clear();
    return this.fetchData(async () => {
      const { data, dependencies } = await aqlQuery(
        this.query.select([...REGISTER_ROW_FIELDS]),
      );
      const groups = data as RegisterGroup[];
      const last = Math.floor((groups.length - 1) / PAGE_SIZE);
      const wanted =
        last < 0
          ? []
          : [...new Set(this.wanted.map(page => Math.min(page, last)))];
      const pages = new Map<number, TransactionEntity[]>();
      for (const page of wanted) {
        const rows = await this.readPage(page, groups);
        if (generation !== this.generation || !this.isRunning) {
          return { data: [], dependencies };
        }
        if (rows) pages.set(page, rows);
      }
      if (generation !== this.generation || !this.isRunning) {
        return { data: [], dependencies };
      }
      this.groups = groups;
      this.rows = groups.flatMap(group => [group, ...group.subtransactions]);
      this.groupIndex = new Map();
      groups.forEach((group, index) => {
        this.groupIndex.set(group.id, index);
        group.subtransactions.forEach(row =>
          this.groupIndex.set(row.id, index),
        );
      });
      this.pages = pages;
      this.refreshing = false;
      return { data: this.loadedRows(), dependencies };
    }).then(() => {
      if (generation === this.generation) {
        this.refreshing = false;
        return this.loadWantedPages();
      }
    });
  };

  private loadedRows = () =>
    [...this.pages.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, transactions]) => transactions);

  getGroup = (id: string): RegisterGroup | undefined => {
    const index = this.groupIndex.get(id);
    if (index !== undefined) return this.groups[index];
  };

  getRow = (id: string): RegisterRow | undefined => {
    const group = this.getGroup(id);
    if (!group) return;
    return group.id === id
      ? group
      : group.subtransactions.find(child => child.id === id);
  };

  requestTransactions = async (ids: readonly string[]) => {
    const pages = new Set<number>();
    for (const id of ids) {
      const index = this.groupIndex.get(id);
      if (index !== undefined) pages.add(Math.floor(index / PAGE_SIZE));
    }
    await Promise.all([...pages].map(page => this.fetchPage(page)));
  };

  // Positions refer to transaction groups in the index. Expanded split rows
  // share the position of their parent group.
  requestRange = (positions: readonly number[]) => {
    const pages = [
      ...new Set(positions.map(index => Math.floor(index / PAGE_SIZE))),
    ];
    if (
      pages.length !== this.wanted.length ||
      pages.some((page, i) => page !== this.wanted[i])
    ) {
      this.wanted = pages;
      this.rangeVersion++;
    }
    void this.loadWantedPages();
  };

  private loadWantedPages = async () => {
    if (
      !this.isRunning ||
      this.groups.length === 0 ||
      this.refreshing ||
      this.loadingRange
    ) {
      return;
    }

    this.loadingRange = true;
    try {
      let version: number;
      do {
        version = this.rangeVersion;
        for (const page of this.wanted) {
          if (
            version !== this.rangeVersion ||
            this.refreshing ||
            !this.isRunning
          ) {
            break;
          }
          if (page * PAGE_SIZE < this.groups.length) await this.fetchPage(page);
        }
      } while (
        version !== this.rangeVersion &&
        !this.refreshing &&
        this.isRunning
      );
    } finally {
      this.loadingRange = false;
    }
  };

  updateCachedTransaction = (transaction: TransactionEntity) => {
    const group = this.groupIndex.get(transaction.id);
    if (group === undefined) return;
    const page = Math.floor(group / PAGE_SIZE);
    const rows = this.pages.get(page);
    if (!rows) return;
    this.pages.set(
      page,
      rows.map(row => {
        if (row.id === transaction.id) return { ...row, ...transaction };
        if (row.id !== transaction.parent_id) return row;
        return {
          ...row,
          subtransactions: row.subtransactions?.map(child =>
            child.id === transaction.id ? { ...child, ...transaction } : child,
          ),
        };
      }),
    );
    this.publishPages();
  };

  private publishPages = () => {
    const previous = this.data;
    this.updateData(this.loadedRows);
    this.onData(this.data, previous);
  };

  private readPage = async (page: number, groups: RegisterGroup[]) => {
    const offset = page * PAGE_SIZE;
    const { data } = await aqlQuery(this.query.limit(PAGE_SIZE).offset(offset));
    const rows = data as TransactionEntity[];
    const expected = groups.slice(offset, offset + PAGE_SIZE);
    // The database may have changed between the index and page queries.
    if (
      rows.length === expected.length &&
      rows.every((row, index) => {
        const group = expected[index];
        const children = row.subtransactions ?? [];
        return (
          row.id === group.id &&
          children.length === group.subtransactions.length &&
          children.every((child, i) => child.id === group.subtransactions[i].id)
        );
      })
    ) {
      return rows;
    }
  };

  private fetchPage = async (page: number) => {
    const cached = this.pages.get(page);
    if (cached) {
      this.pages.delete(page);
      this.pages.set(page, cached);
      return;
    }
    const pending = this.pending.get(page);
    if (pending) return pending;

    const generation = this.generation;
    const load = this.readPage(page, this.groups)
      .then(rows => {
        if (generation !== this.generation || !this.isRunning) return;
        if (!rows) {
          void this.run();
          return;
        }
        this.pages.set(page, rows);
        // Keep requested pages in memory while evicting older cached pages.
        while (this.pages.size > CACHE_PAGES) {
          const victim = [...this.pages.keys()].find(
            key => !this.wanted.includes(key) && key !== page,
          );
          if (victim === undefined) break;
          this.pages.delete(victim);
        }
        this.publishPages();
      })
      .catch(error => console.error('Error fetching register page', error))
      .finally(() => {
        if (generation === this.generation) this.pending.delete(page);
      });
    this.pending.set(page, load);
    return load;
  };
}
