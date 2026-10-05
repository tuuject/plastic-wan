import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  CopyableValue,
  CursorList,
  FilterToolbar,
  LIST_TABLE_CLASS,
  TableShell,
  TextFilter,
  ToneBadge,
} from '@/components/business';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { MessageListItem } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { messagesQuery } from '@/lib/queries';

const ID_LINK =
  'decoration-border hover:decoration-foreground font-medium tabular-nums underline underline-offset-4 transition-colors';

/** Text or caption; non-text kinds carry a neutral kind badge so a sticker row isn't just a dash. */
function MessageCell({ row }: { readonly row: MessageListItem }): React.ReactElement {
  const body = row.text ?? row.caption;
  const showKind = row.kind !== null && row.kind !== 'text';
  if (body === null && !showKind) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex max-w-md items-start gap-2">
      {showKind ? <ToneBadge tone="neutral">{row.kind}</ToneBadge> : null}
      {body === null ? null : <p className="line-clamp-2 break-words">{body}</p>}
    </div>
  );
}

export default function MessagesPage(): React.ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ search, chat }), [search, chat]);

  const COLUMNS: readonly ColumnSpec<MessageListItem>[] = [
    {
      key: 'id',
      title: t('invocations.messages.columns.id'),
      render: (row) => (
        <Link to="/messages/$messageId" params={{ messageId: row.id }} className={ID_LINK}>
          {row.id}
        </Link>
      ),
    },
    {
      key: 'chat',
      title: t('invocations.messages.columns.chat'),
      className: 'min-w-40',
      render: (row) => (
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium break-words">{row.chat.title ?? row.chat.telegram_chat_id}</div>
          <div className="text-muted-foreground text-xs">
            {row.chat.type}
            {row.chat.message_thread_id === 0 ? '' : ` · topic ${row.chat.message_thread_id}`}
          </div>
        </div>
      ),
    },
    {
      key: 'sender',
      title: t('invocations.messages.columns.sender'),
      render: (row) =>
        row.sender === null ? (
          row.sent_by_bot ? (
            <ToneBadge tone="neutral">bot</ToneBadge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        ) : (
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="break-words">{row.sender.display_name}</span>
              {row.sender.is_bot === true ? <ToneBadge tone="neutral">bot</ToneBadge> : null}
            </div>
            <CopyableValue
              label={t(row.sender.telegram_type === 'sender_chat' ? 'common.telegramChatId' : 'common.telegramUserId')}
              value={row.sender.telegram_id}
            />
          </div>
        ),
    },
    {
      key: 'text',
      title: t('invocations.messages.columns.message'),
      className: 'min-w-72 whitespace-normal',
      render: (row) => <MessageCell row={row} />,
    },
    {
      key: 'revision_count',
      title: t('invocations.messages.columns.revisions'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.revision_count),
    },
    {
      key: 'media_count',
      title: t('invocations.messages.columns.media'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.media_count),
    },
    {
      key: 'telegram_message_id',
      title: t('invocations.messages.columns.telegramId'),
      className: 'text-muted-foreground ps-6 tabular-nums',
      render: (row) => row.telegram_message_id,
    },
    {
      key: 'received_at',
      title: t('invocations.messages.columns.received'),
      className: 'text-muted-foreground',
      render: (row) => formatTime(row.received_at),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <TextFilter
          placeholder={t('invocations.messages.searchPlaceholder')}
          value={search}
          onCommit={(value) => setSearch(value.length > 0 ? value : undefined)}
          onClear={() => setSearch(undefined)}
          widthClassName="w-72"
        />
        <ChatFilter value={chat} onChange={setChat} />
      </FilterToolbar>
      <CursorList
        factory={messagesQuery}
        filters={filters}
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('invocations.messages.empty.title')}</EmptyTitle>
              <EmptyDescription>{t('invocations.messages.empty.description')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItems={(items) => (
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} className={LIST_TABLE_CLASS} />
        )}
      />
    </div>
  );
}
