import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { type ColumnSpec, ConfirmDialog, MonoValue, TableShell } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addBotAdmin, type BotAdminEntry, removeBotAdmin } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { adminsQuery } from '@/lib/queries';
import { useTranslation } from 'react-i18next';

const ADMIN_ID_PATTERN = /^\d{1,15}$/;

export default function AdminsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [userIdDraft, setUserIdDraft] = useState('');
  const [userIdError, setUserIdError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BotAdminEntry | null>(null);

  const admins = useQuery(adminsQuery);

  const add = useMutation({
    mutationFn: (userId: number) => addBotAdmin({ telegram_user_id: userId }, admins.data?.revision ?? ''),
    onSuccess: (view) => {
      setAddOpen(false);
      setUserIdDraft('');
      setUserIdError(null);
      toast.success(t('pages.admins.adminAdded'));
      // The response carries the fresh list and revision; skip a refetch.
      queryClient.setQueryData(adminsQuery.queryKey, view);
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
  });

  const remove = useMutation({
    mutationFn: (entry: BotAdminEntry) => removeBotAdmin(entry.telegram_user_id, admins.data?.revision ?? ''),
    onSuccess: (view) => {
      setRemoving(null);
      toast.success(t('pages.admins.adminRemoved'));
      queryClient.setQueryData(adminsQuery.queryKey, view);
    },
    onError: () => {
      // The list refreshes so a row removed elsewhere disappears.
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
  });

  const columns: readonly ColumnSpec<BotAdminEntry>[] = [
    {
      key: 'telegram_user_id',
      title: t('pages.admins.colTelegramUserId'),
      render: (row) => <MonoValue value={row.telegram_user_id} />,
    },
    {
      key: 'actions',
      title: t('pages.admins.colActions'),
      render: (row) => (
        <Button type="button" size="sm" variant="destructive" onClick={() => setRemoving(row)}>
          {t('pages.admins.remove')}
        </Button>
      ),
    },
  ];

  const submitAdd = (): void => {
    const trimmed = userIdDraft.trim();
    if (!ADMIN_ID_PATTERN.test(trimmed)) {
      setUserIdError(t('pages.admins.invalidUserId'));
      return;
    }
    setUserIdError(null);
    add.mutate(Number(trimmed));
  };

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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setAddOpen(true)}>
          {t('pages.admins.addAdmin')}
        </Button>
      </div>

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

      <Dialog open={addOpen} onOpenChange={(open) => !open && setAddOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pages.admins.addTitle')}</DialogTitle>
            <DialogDescription>{t('pages.admins.addDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="admin-user-id">{t('pages.admins.userIdLabel')}</Label>
            <Input
              id="admin-user-id"
              inputMode="numeric"
              placeholder={t('pages.admins.userIdPlaceholder')}
              value={userIdDraft}
              onChange={(event) => {
                setUserIdDraft(event.target.value);
                setUserIdError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submitAdd();
                }
              }}
            />
            {userIdError !== null ? <p className="text-destructive text-sm">{userIdError}</p> : null}
            {add.isError ? <p className="text-destructive text-sm break-words">{errorMessage(add.error)}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={submitAdd} disabled={add.isPending}>
              {add.isPending ? t('pages.admins.adding') : t('pages.admins.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('pages.admins.removeTitle', { id: removing?.telegram_user_id ?? '' })}
        description={t('pages.admins.removeDescription')}
        confirmText={t('pages.admins.removeConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      />
    </div>
  );
}
