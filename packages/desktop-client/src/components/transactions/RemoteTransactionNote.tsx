import { useRef, useState } from 'react';
import { Dialog, DialogTrigger, Heading } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Popover } from '@actual-app/components/popover';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

export function RemoteTransactionNote({
  id,
  notes,
}: {
  id: string;
  notes: string;
}) {
  const { t } = useTranslation();
  return (
    <DialogTrigger>
      <Button
        variant="bare"
        aria-label={
          notes
            ? t('Edit transaction note: {{notes}}', { notes })
            : t('Add transaction note')
        }
        style={{
          minWidth: 0,
          width: '100%',
          display: 'block',
          textAlign: 'left',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {notes || t('Add note')}
      </Button>
      <Popover style={{ width: 320, maxWidth: '90vw', padding: 12 }}>
        <Dialog>
          {({ close }) => <NoteForm id={id} notes={notes} close={close} />}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function NoteForm({
  id,
  notes,
  close,
}: {
  id: string;
  notes: string;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(notes);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);

  async function save() {
    if (pending.current || draft === notes || draft.length > 8192) return;
    pending.current = true;
    setSaving(true);
    try {
      await send('remote-ui/update-transaction-note', { id, notes: draft });
      close();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <View style={{ gap: 8 }}>
        <Heading slot="title" style={{ margin: 0, fontSize: 14 }}>
          <Trans>Transaction note</Trans>
        </Heading>
        <textarea
          aria-label={t('Transaction note')}
          rows={4}
          maxLength={8192}
          value={draft}
          disabled={saving || failed}
          onChange={event => setDraft(event.target.value)}
          style={{
            color: theme.formInputText,
            background: theme.formInputBackground,
            border: '1px solid ' + theme.formInputBorder,
            font: 'inherit',
            resize: 'vertical',
          }}
        />
        {failed && (
          <div role="alert">
            <Trans>
              Could not confirm the save. Close this editor and refresh the
              budget before retrying.
            </Trans>
          </div>
        )}
        <View
          style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}
        >
          <Button onPress={close} isDisabled={saving}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={
              saving || failed || draft === notes || draft.length > 8192
            }
          >
            <Trans>Save</Trans>
          </Button>
        </View>
      </View>
    </form>
  );
}
