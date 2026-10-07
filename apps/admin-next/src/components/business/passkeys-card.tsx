import { startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type ColumnSpec, ConfirmDialog, TableShell, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  deletePasskey,
  deletePassword,
  type PasskeyItem,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { isWebAuthnAvailable, passkeyErrorMessage } from '@/lib/passkeys';
import { passkeysQuery, sessionQuery } from '@/lib/queries';

/**
 * Passkey management card for the Settings page. Rendered only when the
 * session reports `passkeys_enabled`; the WebAuthn ceremony runs in the
 * browser via @simplewebauthn/browser and never exposes credentials to the
 * panel's own storage.
 */
export function PasskeysCard(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const webAuthnAvailable = isWebAuthnAvailable();
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState<PasskeyItem | null>(null);
  const [removingPassword, setRemovingPassword] = useState(false);

  const passkeys = useQuery(passkeysQuery);

  const hasPassword = passkeys.data?.has_password ?? false;
  const items = passkeys.data?.items ?? [];
  const usableCount = items.filter((item) => item.usable).length;
  const lastKeyWithoutPassword = usableCount === 1 && !hasPassword;

  const remove = useMutation({
    mutationFn: deletePasskey,
    retry: false,
    onSuccess: () => {
      setDeleting(null);
      toast.success(t('pages.passkeys.deleted'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });

  const passwordDelete = useMutation({
    mutationFn: deletePassword,
    retry: false,
    onSuccess: async () => {
      setRemovingPassword(false);
      toast.success(t('pages.passkeys.passwordDeleted'));
      // The server rotates the session cookie; both views of the auth state
      // (session flags and the passkey list's own `has_password`) change.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey }),
      ]);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });

  const columns: readonly ColumnSpec<PasskeyItem>[] = [
    {
      key: 'name',
      title: t('pages.passkeys.name'),
      className: 'max-w-52 whitespace-normal [overflow-wrap:anywhere]',
      render: (item) => (
        <div className="space-y-0.5">
          <span className="block">{item.name}</span>
          {!item.usable ? (
            <span className="text-muted-foreground block text-xs">{t('pages.passkeys.unusable')}</span>
          ) : null}
        </div>
      ),
    },
    { key: 'created', title: t('pages.passkeys.created'), render: (item) => formatTime(item.created_at) },
    {
      key: 'last-used',
      title: t('pages.passkeys.lastUsed'),
      render: (item) => (item.last_used_at === null ? t('pages.passkeys.neverUsed') : formatTime(item.last_used_at)),
    },
    {
      key: 'actions',
      title: t('pages.passkeys.actions'),
      render: (item) => (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={remove.isPending || (!hasPassword && usableCount - (item.usable ? 1 : 0) === 0)}
          onClick={() => {
            remove.reset();
            setDeleting(item);
          }}
        >
          {t('pages.passkeys.delete')}
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pages.passkeys.title')}</CardTitle>
        <CardDescription>{t('pages.passkeys.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!webAuthnAvailable ? <p className="text-warning text-sm">{t('pages.passkeys.unsupported')}</p> : null}
        {passkeys.data?.has_password === false ? (
          <p className="text-muted-foreground text-sm">{t('pages.passkeys.noPasswordHint')}</p>
        ) : null}
        {lastKeyWithoutPassword ? (
          <p className="text-warning text-sm">{t('pages.passkeys.deleteLastDisabled')}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!webAuthnAvailable} onClick={() => setRegistering(true)}>
            {t('pages.passkeys.add')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={passkeys.isFetching}
            onClick={() => void passkeys.refetch()}
          >
            {t('common.reload')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!hasPassword || usableCount === 0 || passwordDelete.isPending}
            onClick={() => {
              passwordDelete.reset();
              setRemovingPassword(true);
            }}
          >
            {t('pages.passkeys.passwordDelete')}
          </Button>
        </div>
        {passkeys.data !== undefined ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">{t('pages.passkeys.passwordStatus')}</span>
            <ToneBadge tone={hasPassword ? 'success' : 'neutral'}>
              {hasPassword ? t('pages.passkeys.passwordSet') : t('pages.passkeys.passwordNotSet')}
            </ToneBadge>
          </div>
        ) : null}
        {passkeys.isPending ? (
          <p className="text-muted-foreground py-4 text-center text-sm">{t('common.loading')}</p>
        ) : passkeys.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(passkeys.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={passkeys.isFetching}
              onClick={() => void passkeys.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(item) => item.id}
            emptyText={t('pages.passkeys.empty')}
            className="max-w-full overflow-x-auto"
          />
        )}
      </CardContent>
      {registering ? <RegisterPasskeyDialog onClose={() => setRegistering(false)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
          }
        }}
        title={t('pages.passkeys.deleteTitle', { name: deleting?.name ?? '' })}
        description={
          <span className="[overflow-wrap:anywhere]">
            {t('pages.passkeys.deleteDescription', { name: deleting?.name ?? '' })}
          </span>
        }
        confirmText={t('pages.passkeys.deleteConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null && !remove.isPending) {
            remove.mutate(deleting.id);
          }
        }}
      />
      <ConfirmDialog
        open={removingPassword}
        onOpenChange={(open) => {
          if (!open && !passwordDelete.isPending) {
            setRemovingPassword(false);
          }
        }}
        title={t('pages.passkeys.passwordDeleteTitle')}
        description={t('pages.passkeys.passwordDeleteDescription')}
        confirmText={t('pages.passkeys.passwordDeleteConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={passwordDelete.isPending}
        error={passwordDelete.isError ? errorMessage(passwordDelete.error) : null}
        onConfirm={() => {
          if (!passwordDelete.isPending) {
            passwordDelete.mutate();
          }
        }}
      />
    </Card>
  );
}

function RegisterPasskeyDialog({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);

  const register = useMutation({
    mutationFn: async (passkeyName: string) => {
      const options = await passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      return passkeyRegisterVerify(passkeyName, response);
    },
    retry: false,
    gcTime: 0,
    onSuccess: () => {
      toast.success(t('pages.passkeys.registered'));
      onClose();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !register.isPending && onClose()}>
      <DialogContent
        className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto"
        showCloseButton={!register.isPending}
      >
        <DialogHeader>
          <DialogTitle>{t('pages.passkeys.registerTitle')}</DialogTitle>
          <DialogDescription>{t('pages.passkeys.registerDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (register.isPending) {
              return;
            }
            const trimmed = name.trim();
            if (trimmed.length === 0 || trimmed.length > 80) {
              setNameError(true);
              return;
            }
            setNameError(false);
            register.mutate(trimmed);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="passkey-name">{t('pages.passkeys.nameLabel')}</Label>
            <Input
              id="passkey-name"
              value={name}
              maxLength={80}
              autoComplete="off"
              placeholder={t('pages.passkeys.namePlaceholder')}
              disabled={register.isPending}
              aria-invalid={nameError}
              aria-describedby={nameError ? 'passkey-name-error' : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(false);
              }}
            />
            {nameError ? (
              <p id="passkey-name-error" role="alert" className="text-destructive text-sm">
                {t('pages.passkeys.invalidName')}
              </p>
            ) : null}
            {register.isError ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {passkeyErrorMessage(register.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={register.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={register.isPending}>
              {register.isPending ? t('pages.passkeys.registering') : t('pages.passkeys.registerConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
