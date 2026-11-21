import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';

import { listen, send } from '@actual-app/core/platform/client/connection';
import type { Query } from '@actual-app/core/shared/query';
import { LRUCache } from 'lru-cache';

import { useMetadataPref } from './useMetadataPref';

type SpreadsheetContextValue = ReturnType<typeof makeSpreadsheet>;
const SpreadsheetContext = createContext<SpreadsheetContextValue | undefined>(
  undefined,
);

export function useSpreadsheet() {
  const context = useContext(SpreadsheetContext);
  if (!context) {
    throw new Error('useSpreadsheet must be used within a SpreadsheetProvider');
  }
  return context;
}

// TODO: Make this generic and replace the Binding type in the desktop-client package.
type Binding = string | { name: string; query?: Query | undefined };

type CellCacheValue = { name: string; value: unknown };
type CellCache = { [name: string]: Promise<CellCacheValue> | null };
type CellObserverCallback = (node: CellCacheValue) => void;
type CellObservers = { [name: string]: CellObserverCallback[] };

const GLOBAL_SHEET_NAME = '__global';

function makeSpreadsheet(remoteReadOnly = false) {
  function observe(promise: Promise<unknown>) {
    if (!remoteReadOnly) return;
    // Remote RPC failures are surfaced once by the read-only app's error state.
    void promise.catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
      ) {
        return;
      }
      throw error;
    });
  }
  const cellObservers: CellObservers = {};
  const LRUValueCache = new LRUCache<string, CellCacheValue>({ max: 1200 });
  const cellCache: CellCache = {};
  let observersDisabled = false;

  class Spreadsheet {
    observeCell(name: string, callback: CellObserverCallback): () => void {
      if (!cellObservers[name]) {
        cellObservers[name] = [];
      }
      cellObservers[name].push(callback);

      return () => {
        cellObservers[name] = cellObservers[name].filter(cb => cb !== callback);

        if (cellObservers[name].length === 0) {
          cellCache[name] = null;
          if (remoteReadOnly) {
            const separator = name.indexOf('!');
            observe(
              send('remote-ui/release-cell', {
                sheetName: name.slice(0, separator),
                name: name.slice(separator + 1),
              }),
            );
          }
        }
      };
    }

    disableObservers(): void {
      observersDisabled = true;
    }

    enableObservers(): void {
      observersDisabled = false;
    }

    prewarmCache(name: string, value: CellCacheValue): void {
      LRUValueCache.set(name, value);
    }

    listen(): () => void {
      return listen('cells-changed', event => {
        if (!observersDisabled) {
          // TODO: batch react so only renders once
          event.forEach(node => {
            const observers = cellObservers[node.name];
            if (observers) {
              observers.forEach(func => func(node));
              cellCache[node.name] = Promise.resolve(node);
              LRUValueCache.set(node.name, node);
            } else if (LRUValueCache.has(node.name)) {
              // Keep cached values fresh for views that require remount later
              LRUValueCache.set(node.name, node);
            }
          });
        }
      });
    }

    bind(
      sheetName: string = GLOBAL_SHEET_NAME,
      binding: Binding,
      callback: CellObserverCallback,
    ): () => void {
      binding = typeof binding === 'string' ? { name: binding } : binding;

      if (binding.query) {
        observe(this.createQuery(sheetName, binding.name, binding.query));
      }

      const resolvedName = `${sheetName}!${binding.name}`;
      const cleanup = this.observeCell(resolvedName, callback);

      // Always synchronously call with the existing value if it has one.
      // This is a display optimization to avoid flicker. The LRU cache
      // will keep a number of recent nodes in memory.
      if (LRUValueCache.has(resolvedName)) {
        const node = LRUValueCache.get(resolvedName);
        if (node) {
          callback(node);
        }
      }

      if (cellCache[resolvedName] != null) {
        observe(cellCache[resolvedName].then(callback));
      } else {
        const req = this.get(sheetName, binding.name);
        cellCache[resolvedName] = req;

        observe(
          req.then(result => {
            // We only want to call the callback if it's still waiting on
            // the same request. If we've received a `cells-changed` event
            // for this already then it's already been called and we don't
            // need to call it again (and potentially could be calling it
            // with an old value depending on the order of messages)
            if (cellCache[resolvedName] === req) {
              LRUValueCache.set(resolvedName, result);
              callback(result);
            }
          }),
        );
      }

      return cleanup;
    }

    get(sheetName: string, name: string) {
      return send('get-cell', { sheetName, name });
    }

    getCellNames(sheetName: string) {
      return send('get-cell-names', { sheetName });
    }

    createQuery(sheetName: string, name: string, query: Query) {
      return send('create-query', {
        sheetName,
        name,
        query: query.serialize(),
      });
    }
  }

  return new Spreadsheet();
}

type SpreadsheetProviderProps = {
  children: ReactNode;
};

export function SpreadsheetProvider({ children }: SpreadsheetProviderProps) {
  const [budgetId] = useMetadataPref('id');
  return (
    <BudgetSpreadsheetProvider key={budgetId}>
      {children}
    </BudgetSpreadsheetProvider>
  );
}

function BudgetSpreadsheetProvider({ children }: SpreadsheetProviderProps) {
  const [remoteReadOnly] = useMetadataPref('remoteReadOnly');
  const spreadsheet = useMemo(
    () => makeSpreadsheet(remoteReadOnly),
    [remoteReadOnly],
  );

  useEffect(() => {
    return spreadsheet.listen();
  }, [spreadsheet]);

  return (
    <SpreadsheetContext.Provider value={spreadsheet}>
      {children}
    </SpreadsheetContext.Provider>
  );
}
