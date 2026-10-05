import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type ColumnSpec, ConfirmDialog, MonoValue, TableShell, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { type AdminApiKeyItem, createApiKey, revokeApiKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { apiKeysQuery } from '@/lib/queries';

export default function ApiKeysPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keys = useQuery(apiKeysQuery);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AdminApiKeyItem | null>(null);
  const revoke = useMutation({
    mutationFn: revokeApiKey,
    retry: false,
    onSuccess: () => {
      setRevoking(null);
      toast.success(t('pages.apiKeys.revokedMessage'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });
  const columns: readonly ColumnSpec<AdminApiKeyItem>[] = [
    {
      key: 'name',
      title: t('pages.apiKeys.name'),
      className: 'max-w-52 whitespace-normal [overflow-wrap:anywhere]',
      render: (item) => item.name,
    },
    {
      key: 'prefix',
      title: t('pages.apiKeys.prefix'),
      render: (item) => <MonoValue value={`${item.prefix}…`} />,
    },
    { key: 'created', title: t('pages.apiKeys.created'), render: (item) => formatTime(item.created_at) },
    {
      key: 'last-used',
      title: t('pages.apiKeys.lastUsed'),
      render: (item) => (item.last_used_at === null ? t('pages.apiKeys.neverUsed') : formatTime(item.last_used_at)),
    },
    {
      key: 'status',
      title: t('pages.apiKeys.status'),
      render: (item) => (
        <div className="space-y-1">
          <ToneBadge tone={item.revoked_at === null ? 'success' : 'neutral'}>
            {item.revoked_at === null ? t('pages.apiKeys.active') : t('pages.apiKeys.revoked')}
          </ToneBadge>
          {item.revoked_at === null ? null : (
            <p className="text-muted-foreground text-xs">{formatTime(item.revoked_at)}</p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      render: (item) =>
        item.revoked_at === null ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.reset();
              setRevoking(item);
            }}
          >
            {t('pages.apiKeys.revoke')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('pages.apiKeys.title')}</CardTitle>
          <CardDescription>{t('pages.apiKeys.description')}</CardDescription>
        </CardHeader>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => setCreating(true)}>
          {t('pages.apiKeys.create')}
        </Button>
        <Button type="button" variant="outline" disabled={keys.isFetching} onClick={() => void keys.refetch()}>
          {t('common.reload')}
        </Button>
      </div>
      {keys.isPending ? (
        <p className="text-muted-foreground py-8 text-center text-sm">{t('common.loading')}</p>
      ) : keys.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive text-sm break-words">
            {errorMessage(keys.error)}
          </p>
          <Button type="button" variant="outline" disabled={keys.isFetching} onClick={() => void keys.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <TableShell
          columns={columns}
          data={keys.data.items}
          rowKey={(item) => item.id}
          emptyText={t('pages.apiKeys.empty')}
          className="max-w-full overflow-x-auto"
        />
      )}
      {creating ? <CreateKeyDialog onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) {
            setRevoking(null);
          }
        }}
        title={t('pages.apiKeys.revokeTitle')}
        description={
          <span className="[overflow-wrap:anywhere]">
            {t('pages.apiKeys.revokeDescription', { name: revoking?.name ?? '' })}
          </span>
        }
        confirmText={t('pages.apiKeys.revokeConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={revoke.isPending}
        error={revoke.isError ? errorMessage(revoke.error) : null}
        onConfirm={() => {
          if (revoking !== null && !revoke.isPending) {
            revoke.mutate(revoking.id);
          }
        }}
      />
    </div>
  );
}

function CreateKeyDialog({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const create = useMutation({
    // Return nothing: mutation/query caches must never retain the one-time key.
    // Closing this dialog unmounts its local state, rather than hiding the key.
    mutationFn: async (keyName: string): Promise<void> => {
      const result = await createApiKey(keyName);
      setPlaintext(result.key);
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      // A lost create response can still have issued a key; refresh metadata so it can be revoked.
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto" showCloseButton={!create.isPending}>
        <DialogHeader>
          <DialogTitle>{plaintext === null ? t('pages.apiKeys.create') : t('pages.apiKeys.saveTitle')}</DialogTitle>
          <DialogDescription>
            {plaintext === null ? t('pages.apiKeys.createDescription') : t('pages.apiKeys.saveDescription')}
          </DialogDescription>
        </DialogHeader>
        {plaintext === null ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (create.isPending) {
                return;
              }
              const trimmed = name.trim();
              if (trimmed.length === 0 || trimmed.length > 80) {
                setNameError(true);
                return;
              }
              setNameError(false);
              create.mutate(trimmed);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="api-key-name">{t('pages.apiKeys.name')}</Label>
              <Input
                id="api-key-name"
                value={name}
                maxLength={80}
                autoComplete="off"
                placeholder={t('pages.apiKeys.namePlaceholder')}
                disabled={create.isPending}
                aria-invalid={nameError}
                aria-describedby={nameError ? 'api-key-name-error' : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(false);
                }}
              />
              {nameError ? (
                <p id="api-key-name-error" role="alert" className="text-destructive text-sm">
                  {t('pages.apiKeys.invalidName')}
                </p>
              ) : null}
              {create.isError ? (
                <p role="alert" className="text-destructive text-sm break-words">
                  {errorMessage(create.error)}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? t('pages.apiKeys.creating') : t('pages.apiKeys.createConfirm')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="api-key-plaintext">{t('pages.apiKeys.keyLabel')}</Label>
              <Textarea
                id="api-key-plaintext"
                value={plaintext}
                readOnly
                autoComplete="off"
                spellCheck={false}
                className="resize-none break-all font-mono"
                onFocus={(event) => event.target.select()}
              />
              {copyState === 'failed' ? (
                <p role="alert" className="text-destructive text-sm">
                  {t('pages.apiKeys.copyFailed')}
                </p>
              ) : copyState === 'copied' ? (
                <p role="status" className="text-success text-sm">
                  {t('common.copied')}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={copyState === 'pending'}
                onClick={async () => {
                  setCopyState('pending');
                  try {
                    await navigator.clipboard.writeText(plaintext);
                    setCopyState('copied');
                  } catch {
                    setCopyState('failed');
                  }
                }}
              >
                {t('pages.apiKeys.copy')}
              </Button>
              <Button type="button" onClick={onClose}>
                {t('pages.apiKeys.done')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
