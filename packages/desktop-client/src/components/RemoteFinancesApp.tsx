import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Trans, useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import {
  SvgLockClosed,
  SvgRefreshArrow,
} from '@actual-app/components/icons/v2';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { listen, send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import { useQueryClient } from '@tanstack/react-query';

import { closeBudget } from '#budgetfiles/budgetfilesSlice';
import { Account } from '#components/accounts/Account';
import { accountNameStyle } from '#components/sidebar/Account';
import { SidebarShell } from '#components/sidebar/SidebarShell';
import { useAccounts } from '#hooks/useAccounts';
import { useCategories } from '#hooks/useCategories';
import { useFormat } from '#hooks/useFormat';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useNavigate } from '#hooks/useNavigate';
import { usePayees } from '#hooks/usePayees';
import { ScrollProvider } from '#hooks/useScrollListener';
import { useSheetValue } from '#hooks/useSheetValue';
import { addNotification } from '#notifications/notificationsSlice';
import { mergeLocalPrefs } from '#prefs/prefsSlice';
import { useDispatch } from '#redux';
import * as bindings from '#spreadsheet/bindings';

import { Link } from './common/Link';
import { FeatureErrorFallback } from './FeatureErrorFallback';

function AccountLink({ account }: { account?: AccountEntity }) {
  const { t } = useTranslation();
  const format = useFormat();
  const balance = useSheetValue<'account', 'balance' | 'accounts-balance'>(
    account
      ? bindings.accountBalance(account.id)
      : bindings.allAccountBalance(),
  );
  return (
    <Link
      variant="internal"
      to={account ? `/accounts/${account.id}` : '/accounts'}
      isExactPathMatch
      style={{
        ...accountNameStyle,
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
      }}
      activeStyle={{ color: theme.sidebarItemTextSelected }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {account?.name ?? t('All accounts')}
      </span>
      <span style={{ ...styles.tnum, flexShrink: 0 }}>
        {balance == null ? '—' : format(balance, 'financial')}
      </span>
    </Link>
  );
}

/** First remote milestone: reuse account screens, without any editing routes. */
export function RemoteFinancesApp() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const initialNavigation = useRef(false);
  const { isNarrowWidth } = useResponsive();
  const [budgetName] = useMetadataPref('budgetName');
  const [editTransactions] = useMetadataPref('remoteTransactionEdits');
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();
  const [refreshing, setRefreshing] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const scrollableRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      listen('remote-ui-error', ({ code }) => {
        if (code === 'access-lost' || code === 'budget-not-found') {
          setAccessLost(true);
        }
        setRefreshFailed(true);
      }),
    [],
  );
  useEffect(() => {
    if (!initialNavigation.current) {
      initialNavigation.current = true;
      void navigate('/accounts', { replace: true, state: null });
    }
  }, [navigate]);

  async function switchEditMode() {
    if (switchingMode) return;
    const next = !editTransactions;
    setSwitchingMode(true);
    try {
      await send('remote-ui/set-edit-mode', { editTransactions: next });
      dispatch(
        mergeLocalPrefs({ remoteTransactionEdits: next ? true : undefined }),
      );
    } catch {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            message: t('Could not change editing mode. Try again.'),
          },
        }),
      );
    } finally {
      setSwitchingMode(false);
    }
  }

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      await send('sync');
      await queryClient.invalidateQueries();
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  const loading =
    accounts.isPending ||
    payees.isPending ||
    categories.isPending ||
    accounts.isPlaceholderData ||
    payees.isPlaceholderData ||
    categories.isPlaceholderData;
  const failed =
    accounts.isError ||
    payees.isError ||
    categories.isError ||
    refreshFailed ||
    accessLost;
  return (
    <View
      style={{
        height: '100%',
        flexDirection: 'row',
        backgroundColor: theme.pageBackground,
        color: theme.pageText,
      }}
    >
      {!isNarrowWidth && !accessLost && (
        <SidebarShell defaultWidth={240}>
          <Text style={{ ...styles.smallText, padding: 20 }}>{budgetName}</Text>
          <nav aria-label={t('Accounts')} style={{ overflowY: 'auto' }}>
            {!loading && !failed && <AccountLink />}
            {accounts.data?.map(account => (
              <AccountLink key={account.id} account={account} />
            ))}
          </nav>
        </SidebarShell>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: '10px 20px',
            flexShrink: 0,
          }}
        >
          <SvgLockClosed width={13} height={13} aria-hidden="true" />
          <Text style={styles.smallText}>
            {editTransactions
              ? t('Notes and clearing editable')
              : t('Read-only')}
          </Text>
          <View style={{ flex: 1 }} />
          {!isNarrowWidth && !accessLost && (
            <Button
              isDisabled={refreshing || switchingMode}
              onPress={() => void switchEditMode()}
            >
              {editTransactions
                ? t('Switch to read-only')
                : t('Enable limited editing')}
            </Button>
          )}
          <Button
            onPress={() => void refresh()}
            isDisabled={refreshing || accessLost || switchingMode}
          >
            <SvgRefreshArrow width={13} height={13} aria-hidden="true" />{' '}
            <Trans>Refresh</Trans>
          </Button>
          <Button
            isDisabled={switchingMode}
            onPress={() => void dispatch(closeBudget())}
          >
            <Trans>Close</Trans>
          </Button>
        </View>
        {failed && (
          <Text
            role="alert"
            style={{ padding: '10px 20px', color: theme.pageText }}
          >
            {accessLost
              ? t(
                  'Access to this budget ended. Close it and sign in again to reopen it.',
                )
              : t(
                  'Unable to load this budget. Check your connection and try again.',
                )}
          </Text>
        )}
        {isNarrowWidth ? (
          <Text style={{ padding: 20 }}>
            <Trans>
              Open this budget in a wider window to view accounts and
              transactions.
            </Trans>
          </Text>
        ) : loading ? (
          <Text role="status" style={{ padding: 20 }}>
            {t('Loading...')}
          </Text>
        ) : (
          !failed && (
            <ScrollProvider isDisabled scrollableRef={scrollableRef}>
              <ErrorBoundary
                FallbackComponent={FeatureErrorFallback}
                resetKeys={[location.pathname]}
              >
                <Routes>
                  <Route path="/accounts" element={<Account />} />
                  <Route path="/accounts/:id" element={<Account />} />
                  <Route
                    path="*"
                    element={<Navigate to="/accounts" replace />}
                  />
                </Routes>
              </ErrorBoundary>
            </ScrollProvider>
          )
        )}
      </View>
    </View>
  );
}
