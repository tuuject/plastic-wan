import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  CopyableValue,
  DetailError,
  DetailSkeleton,
  JsonViewer,
  KvList,
  MonoValue,
  TableShell,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MediaEntry, MessageDetail, RevisionEntry } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { messageQuery } from '@/lib/queries';

function YesNoBadge({ value }: { readonly value: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return value ? (
    <ToneBadge tone="success">{t('invocations.messageDetail.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('invocations.messageDetail.no')}</ToneBadge>
  );
}

function DetailHeader({ message }: { readonly message: MessageDetail }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
        <CardTitle className="font-mono text-base break-all">
          {t('invocations.messageDetail.title', { id: message.id })}
        </CardTitle>
        <Link to="/messages" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
          {t('invocations.messageDetail.backToList')}
        </Link>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-0">
        <KvList
          items={[
            {
              label: t('invocations.messageDetail.kv.telegramMessageId'),
              value: <MonoValue value={message.telegram_message_id} />,
            },
            {
              label: t('invocations.messageDetail.kv.chat'),
              value: <TextValue value={message.chat.title ?? message.chat.telegram_chat_id} />,
            },
            {
              label: t('invocations.messageDetail.kv.chatId'),
              value: <MonoValue value={message.chat.telegram_chat_id} />,
            },
            { label: t('invocations.messageDetail.kv.chatType'), value: <TextValue value={message.chat.type} /> },
            { label: t('invocations.messageDetail.kv.topic'), value: String(message.chat.message_thread_id) },
            { label: t('invocations.messageDetail.kv.visible'), value: <YesNoBadge value={message.visible} /> },
            { label: t('invocations.messageDetail.kv.sentByBot'), value: <YesNoBadge value={message.sent_by_bot} /> },
            { label: t('invocations.messageDetail.kv.telegramDate'), value: formatTime(message.telegram_date) },
            { label: t('invocations.messageDetail.kv.received'), value: formatTime(message.received_at) },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function RevisionsTable({ message }: { readonly message: MessageDetail }): React.ReactElement {
  const { t } = useTranslation();
  const REVISION_COLUMNS: readonly ColumnSpec<RevisionEntry>[] = [
    {
      key: 'revision_no',
      title: t('invocations.messageDetail.revisionColumns.sequence'),
      align: 'right',
      width: 60,
      render: (row) => String(row.revision_no),
    },
    { key: 'kind', title: t('invocations.messageDetail.revisionColumns.kind'), render: (row) => row.kind },
    {
      key: 'sender',
      title: t('invocations.messageDetail.revisionColumns.sender'),
      render: (row) => (
        <div className="min-w-0 space-y-0.5">
          <TextValue value={row.sender?.display_name ?? null} />
          {row.sender === null ? null : (
            <CopyableValue
              label={t(row.sender.telegram_type === 'sender_chat' ? 'common.telegramChatId' : 'common.telegramUserId')}
              value={row.sender.telegram_id}
            />
          )}
        </div>
      ),
    },
    {
      key: 'text',
      title: t('invocations.messageDetail.revisionColumns.text'),
      className: 'min-w-72 max-w-2xl whitespace-normal',
      render: (row) => (
        <p className="max-w-2xl text-sm break-words whitespace-pre-wrap">{row.text ?? row.caption ?? '—'}</p>
      ),
    },
    {
      key: 'reply_to_message_id',
      title: t('invocations.messageDetail.revisionColumns.replyTo'),
      render: (row) => <TextValue value={row.reply_to_message_id} />,
    },
    {
      key: 'created_at',
      title: t('invocations.messageDetail.revisionColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TableShell
      columns={REVISION_COLUMNS}
      data={message.revisions}
      rowKey={(row) => row.id}
      emptyText={t('invocations.messageDetail.noRevisions')}
      expandedRender={(row) => (
        <div className="space-y-2">
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.messageDetail.replySnapshot')}</p>
            <JsonViewer value={row.reply_snapshot_json} />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.messageDetail.forwardOrigin')}</p>
            <JsonViewer value={row.forward_origin_json} />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.messageDetail.servicePayload')}</p>
            <JsonViewer value={row.service_json} />
          </div>
        </div>
      )}
    />
  );
}

function MediaTable({ message }: { readonly message: MessageDetail }): React.ReactElement {
  const { t } = useTranslation();
  const MEDIA_COLUMNS: readonly ColumnSpec<MediaEntry>[] = [
    { key: 'kind', title: t('invocations.messageDetail.mediaColumns.kind'), render: (row) => row.kind },
    {
      key: 'file_unique_id',
      title: t('invocations.messageDetail.mediaColumns.fileUniqueId'),
      render: (row) => (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{row.file_unique_id}</code>
      ),
    },
    {
      key: 'mime_type',
      title: t('invocations.messageDetail.mediaColumns.mime'),
      render: (row) => <TextValue value={row.mime_type} />,
    },
    {
      key: 'file_size',
      title: t('invocations.messageDetail.mediaColumns.size'),
      align: 'right',
      render: (row) => formatNumber(row.file_size),
    },
    {
      key: 'dimensions',
      title: t('invocations.messageDetail.mediaColumns.dimensions'),
      render: (row) =>
        row.width === null || row.height === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${row.width}×${row.height}`
        ),
    },
    {
      key: 'analysis',
      title: t('invocations.messageDetail.mediaColumns.analysis'),
      className: 'min-w-56 max-w-md',
      render: (row) => <TextValue value={row.analysis_description ?? row.analysis_state} />,
    },
  ];
  return (
    <TableShell
      columns={MEDIA_COLUMNS}
      data={message.media}
      rowKey={(row) => row.id}
      emptyText={t('invocations.messageDetail.noMedia')}
    />
  );
}

export function MessageDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useQuery(messageQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle={t('invocations.messageDetail.notFound')}
        failedTitle={t('invocations.messageDetail.loadFailed')}
        backTo="/messages"
        backLabel={t('invocations.messageDetail.backToMessages')}
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error(t('invocations.messageDetail.dataMissing'))}
        notFoundTitle={t('invocations.messageDetail.notFound')}
        failedTitle={t('invocations.messageDetail.loadFailed')}
        backTo="/messages"
        backLabel={t('invocations.messageDetail.backToMessages')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <DetailHeader message={data} />
      <Card>
        <CardHeader>
          <CardTitle>{t('invocations.messageDetail.revisionsTitle', { count: data.revisions.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          <RevisionsTable message={data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('invocations.messageDetail.mediaTitle', { count: data.media.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          <MediaTable message={data} />
        </CardContent>
      </Card>
    </div>
  );
}
