import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { type ColumnSpec, MonoValue, TableShell } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { BotAdminEntry } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { adminsQuery } from '@/lib/queries';
import { useTranslation } from 'react-i18next';

export default function AdminsPage(): React.ReactElement {
  const { t } = useTranslation();
  const admins = useQuery(adminsQuery);

  const columns: readonly ColumnSpec<BotAdminEntry>[] = [
    {
      key: 'telegram_user_id',
      title: t('pages.admins.colTelegramUserId'),
      render: (row) => <MonoValue value={row.telegram_user_id} />,
    },
  ];

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>{t('pages.admins.alertTitle')}</AlertTitle>
        <AlertDescription>
          {t('pages.admins.alertDesc1')} <code>/pause</code> {t('pages.admins.alertDesc2')} <code>/resume</code>{' '}
          {t('pages.admins.alertDesc3')} <code>@userinfobot</code>
          {t('pages.admins.alertDesc4')} <code>telegram.admins</code> {t('pages.admins.alertDesc5')}
        </AlertDescription>
      </Alert>

      {admins.isPending ? (
        <div className="text-muted-foreground py-8 text-center text-sm">{t('pages.admins.loadingAdmins')}</div>
      ) : admins.isError ? (
        <p className="text-destructive text-sm break-words">{errorMessage(admins.error)}</p>
      ) : (
        <TableShell
          columns={columns}
          data={admins.data.items}
          rowKey={(row) => row.telegram_user_id}
          emptyText={t('pages.admins.emptyAdmins')}
          className="max-w-full overflow-x-auto"
        />
      )}
    </div>
  );
}
