import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import {
  SvgCheckCircle1,
  SvgCheckCircleHollow,
} from '@actual-app/components/icons/v2';
import { theme } from '@actual-app/components/theme';
import { send } from '@actual-app/core/platform/client/connection';

import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

export function RemoteTransactionCleared({
  id,
  cleared,
}: {
  id: string;
  cleared: boolean;
}) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);

  async function toggleCleared() {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await send('remote-ui/update-transaction-cleared', {
        id,
        cleared: !cleared,
      });
      if (result !== 'updated') {
        dispatch(
          addNotification({
            notification: {
              type: 'error',
              message:
                result === 'reconciled'
                  ? t(
                      'This transaction is reconciled. Refresh to see its current status.',
                    )
                  : t(
                      'This transaction can no longer be cleared here. Refresh to see its current status.',
                    ),
            },
          }),
        );
      }
    } catch {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            message: t(
              'Could not confirm the clearing change. Refresh before trying again.',
            ),
          },
        }),
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  const Icon = cleared ? SvgCheckCircle1 : SvgCheckCircleHollow;
  return (
    <Button
      variant="bare"
      aria-label={
        cleared
          ? t('Mark transaction as uncleared')
          : t('Mark transaction as cleared')
      }
      isDisabled={saving}
      onPress={() => void toggleCleared()}
      style={{
        padding: 3,
        borderRadius: 50,
        color: cleared ? theme.noticeTextLight : theme.tableText,
      }}
    >
      <Icon aria-hidden="true" width={13} height={13} />
    </Button>
  );
}
