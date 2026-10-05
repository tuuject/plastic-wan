import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BadgeSemantic,
  type ColumnSpec,
  CopyableValue,
  DetailError,
  DetailSkeleton,
  JsonViewer,
  KvList,
  LazyDetails,
  MonoValue,
  PrivateReasoningNote,
  PrivateReasoningTag,
  StateBadge,
  TableShell,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  AgentMessageEntry,
  ContextMessageEntry,
  InvocationDetail,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
  ToolRegistryEntry,
} from '@/lib/api';
import { formatCost, formatDuration, formatNumber, formatTime } from '@/lib/format';
import { invocationQuery } from '@/lib/queries';
import {
  buildInvocationTimeline,
  type InvocationTimelineEvent,
  isNewContextSection,
  objectField,
  type ParsedSendArguments,
  parseJsonObject,
  parseSendArguments,
  stringField,
  timelineEventKey,
} from '@/lib/timeline';
import { cn } from '@/lib/utils';

const ROLE_BADGE_TONES: Record<string, BadgeSemantic> = {
  assistant: 'warning',
  tool_result: 'info',
};

function RoleBadge({ role }: { readonly role: string }): React.ReactElement {
  return <ToneBadge tone={ROLE_BADGE_TONES[role] ?? 'neutral'}>{role}</ToneBadge>;
}

function SectionBadge({ section }: { readonly section: string }): React.ReactElement {
  const { t } = useTranslation();
  const isNew = isNewContextSection(section);
  return (
    <ToneBadge tone={isNew ? 'info' : 'neutral'}>
      {isNew ? t('invocations.invocationDetail.section.incoming') : t('invocations.invocationDetail.section.history')}
    </ToneBadge>
  );
}

function YesNoBadge({ value }: { readonly value: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return value ? (
    <ToneBadge tone="warning">{t('invocations.messageDetail.yes')}</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">{t('invocations.messageDetail.no')}</ToneBadge>
  );
}

function ToolRegistryTable({ registry }: { readonly registry: readonly ToolRegistryEntry[] }): React.ReactElement {
  const { t } = useTranslation();
  const columns: readonly ColumnSpec<ToolRegistryEntry>[] = [
    {
      key: 'name',
      title: t('invocations.invocationDetail.toolRegistry.name'),
      render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{row.name}</code>,
    },
    { key: 'label', title: t('invocations.invocationDetail.toolRegistry.label'), render: (row) => row.label },
    {
      key: 'description',
      title: t('invocations.invocationDetail.toolRegistry.description'),
      className: 'min-w-64 max-w-2xl',
      render: (row) => <p className="max-w-2xl text-sm break-words">{row.description}</p>,
    },
  ];
  return (
    <LazyDetails
      summaryClassName="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
      contentClassName="mt-2"
      summary={
        <>
          {t('invocations.invocationDetail.toolRegistry.title')}
          <span className="text-xs">{t('invocations.invocationDetail.toolRegistry.subtitle')}</span>
        </>
      }
    >
      <TableShell columns={columns} data={registry} rowKey={(row) => row.name} />
    </LazyDetails>
  );
}

function DetailHeader({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
        <CardTitle className="font-mono text-base break-all">
          {t('invocations.invocationDetail.title', { id: invocation.id })}
        </CardTitle>
        <Link to="/invocations" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
          {t('invocations.invocationDetail.backToList')}
        </Link>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-0">
        <KvList
          items={[
            { label: t('invocations.invocationDetail.kv.state'), value: <StateBadge state={invocation.state} /> },
            {
              label: t('invocations.invocationDetail.kv.completionReason'),
              value: <TextValue value={invocation.completion_reason} />,
            },
            {
              label: t('invocations.invocationDetail.kv.errorCode'),
              value: <TextValue value={invocation.error_code} />,
            },
            {
              label: t('invocations.invocationDetail.kv.chat'),
              value: <TextValue value={invocation.chat.title ?? invocation.chat.telegram_chat_id} />,
            },
            {
              label: t('invocations.invocationDetail.kv.chatId'),
              value: <MonoValue value={invocation.chat.telegram_chat_id} />,
            },
            { label: t('invocations.invocationDetail.kv.topic'), value: String(invocation.chat.message_thread_id) },
            { label: t('invocations.invocationDetail.kv.bucket'), value: <MonoValue value={invocation.bucket_id} /> },
            { label: t('invocations.invocationDetail.kv.created'), value: formatTime(invocation.created_at) },
            { label: t('invocations.invocationDetail.kv.started'), value: formatTime(invocation.started_at) },
            { label: t('invocations.invocationDetail.kv.finished'), value: formatTime(invocation.finished_at) },
            { label: t('invocations.invocationDetail.kv.tokens'), value: formatNumber(invocation.total_tokens) },
            {
              label: t('invocations.invocationDetail.kv.cacheRead'),
              value: formatNumber(invocation.cache_read_tokens),
            },
            {
              label: t('invocations.invocationDetail.kv.cacheWrite'),
              value: formatNumber(invocation.cache_write_tokens),
            },
            { label: t('invocations.invocationDetail.kv.cost'), value: formatCost(invocation.total_cost) },
            {
              label: t('invocations.invocationDetail.kv.configHash'),
              value: <MonoValue value={invocation.config_hash.slice(0, 16)} />,
            },
            { label: t('invocations.invocationDetail.kv.promptVersion'), value: String(invocation.prompt_version) },
            {
              label: t('invocations.invocationDetail.kv.toolRegistryHash'),
              value: <TextValue value={invocation.tool_registry_hash} />,
            },
          ]}
        />
        {invocation.tool_registry !== null && invocation.tool_registry.length > 0 ? (
          <ToolRegistryTable registry={invocation.tool_registry} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function TimelineCard({
  header,
  extra,
  children,
}: {
  readonly header: React.ReactNode;
  readonly extra?: string;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 px-3 py-0">
        <div className="flex flex-wrap items-center gap-1.5">{header}</div>
        {extra !== undefined ? <span className="text-muted-foreground text-xs">{extra}</span> : null}
      </CardHeader>
      {children !== undefined ? <CardContent className="space-y-2 px-3 py-0">{children}</CardContent> : null}
    </Card>
  );
}

function SendContent({
  parsed,
  send,
}: {
  readonly parsed: ParsedSendArguments;
  readonly send: TelegramSendEntry | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const content =
    parsed.kind === 'text'
      ? parsed.text
      : parsed.kind === 'sticker' && parsed.sticker_ref !== null
        ? t('invocations.invocationDetail.send.sticker', { ref: parsed.sticker_ref })
        : null;
  return (
    <div className="space-y-1.5">
      {content === null ? (
        <p className="text-muted-foreground text-sm">{t('invocations.invocationDetail.send.noContent')}</p>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{content}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        {parsed.reply_to_message_id !== null ? (
          <span>{t('invocations.invocationDetail.send.replyTo', { id: parsed.reply_to_message_id })}</span>
        ) : null}
        {send !== null ? (
          <>
            <span>{t('invocations.invocationDetail.send.delivery')}</span>
            <StateBadge state={send.state} />
            {send.telegram_message_id !== null ? (
              <span>{t('invocations.invocationDetail.send.messageLabel', { id: send.telegram_message_id })}</span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ToolCallCard({
  tool,
  send,
}: {
  readonly tool: ToolCallEntry;
  readonly send: TelegramSendEntry | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const parsed = parseSendArguments(tool.arguments_json);
  return (
    <TimelineCard
      header={
        <>
          <ToneBadge tone={tool.tool_name === 'send' ? 'success' : 'neutral'}>{tool.tool_name}</ToneBadge>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{tool.tool_call_id}</code>
          <StateBadge state={tool.state} />
        </>
      }
      extra={formatTime(tool.created_at)}
    >
      {tool.tool_name === 'send' ? <SendContent parsed={parsed} send={send} /> : null}
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>{t('invocations.invocationDetail.toolCall.duration', { value: formatDuration(tool.duration_ms) })}</span>
        {tool.error_code !== null ? (
          <span className="text-destructive">
            {t('invocations.invocationDetail.toolCall.error', { code: tool.error_code })}
          </span>
        ) : null}
      </div>
      <LazyDetails
        summary={t('invocations.invocationDetail.toolCall.argumentsAndResult')}
        summaryClassName="text-muted-foreground cursor-pointer text-xs"
        contentClassName="mt-2 space-y-2"
      >
        <JsonViewer value={tool.arguments_json} title={t('invocations.invocationDetail.toolCall.arguments')} />
        <JsonViewer value={tool.result_text} title={t('invocations.invocationDetail.toolCall.result')} />
      </LazyDetails>
    </TimelineCard>
  );
}

function ContextMessageCard({ message }: { readonly message: ContextMessageEntry }): React.ReactElement {
  const { t } = useTranslation();
  const snapshot = parseJsonObject(message.snapshot_json);
  const sender = objectField(snapshot, 'sender');
  const username = stringField(sender, 'username');
  const senderName =
    stringField(sender, 'name') ??
    (username === null ? t('invocations.invocationDetail.contextMessage.unknownSender') : `@${username}`);
  const telegramMessageId = stringField(snapshot, 'message_id');
  const kind = stringField(snapshot, 'kind') ?? 'message';
  const text = stringField(snapshot, 'text') ?? stringField(snapshot, 'caption');
  const media = snapshot?.media;
  const mediaCount = Array.isArray(media) ? media.length : 0;
  const sentByBot = snapshot?.sent_by_bot === true;
  return (
    <TimelineCard
      header={
        <>
          <SectionBadge section={message.section} />
          <span className="text-sm font-medium">{senderName}</span>
          {username !== null && senderName !== `@${username}` ? (
            <span className="text-muted-foreground text-xs">@{username}</span>
          ) : null}
          {sentByBot ? <span className="text-muted-foreground text-xs">bot</span> : null}
          <CopyableValue label={t('common.telegramSenderId')} value={stringField(sender, 'id')} />
        </>
      }
      extra={formatTime(stringField(snapshot, 'telegram_date'))}
    >
      {text === null ? (
        <p className="text-muted-foreground text-sm">
          {kind}
          {mediaCount === 0 ? '' : t('invocations.invocationDetail.contextMessage.mediaCount', { count: mediaCount })}
        </p>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{text}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>
          {telegramMessageId === null
            ? kind
            : t('invocations.invocationDetail.contextMessage.telegramMessage', {
                id: telegramMessageId,
                kind,
              })}
        </span>
        <Link
          to="/messages/$messageId"
          params={{ messageId: message.message_id }}
          className="text-primary underline-offset-4 hover:underline"
        >
          {t('invocations.invocationDetail.contextMessage.openRecord')}
        </Link>
      </div>
    </TimelineCard>
  );
}

function AgentMessageCard({ message }: { readonly message: AgentMessageEntry }): React.ReactElement {
  const { t } = useTranslation();
  const AGENT_ROLE_LABELS: Record<string, { readonly label: string; readonly note: string | null }> = {
    assistant: {
      label: t('invocations.invocationDetail.agentRoles.assistantLabel'),
      note: t('invocations.invocationDetail.agentRoles.assistantNote'),
    },
    tool_result: { label: t('invocations.invocationDetail.agentRoles.toolResultLabel'), note: null },
    harness_nudge: {
      label: t('invocations.invocationDetail.agentRoles.harnessNudgeLabel'),
      note: t('invocations.invocationDetail.agentRoles.harnessNudgeNote'),
    },
  };
  const meta = AGENT_ROLE_LABELS[message.role] ?? { label: message.role, note: null };
  return (
    <TimelineCard
      header={
        <>
          <RoleBadge role={message.role} />
          <span className="text-sm">{meta.label}</span>
          {meta.note !== null ? <span className="text-muted-foreground text-xs">{meta.note}</span> : null}
          {message.role === 'assistant' ? <PrivateReasoningTag /> : null}
        </>
      }
      extra={formatTime(message.created_at)}
    >
      {message.text.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('invocations.invocationDetail.agent.noText')}</p>
      ) : message.role === 'tool_result' ? (
        <LazyDetails
          summary={t('invocations.invocationDetail.agent.viewToolResult')}
          summaryClassName="text-muted-foreground cursor-pointer text-xs"
          contentClassName="mt-1 text-sm break-words whitespace-pre-wrap"
        >
          {message.text}
        </LazyDetails>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
      )}
    </TimelineCard>
  );
}

function ModelCallCard({ model }: { readonly model: ModelCallEntry }): React.ReactElement {
  const { t } = useTranslation();
  const hasDetails = model.error_detail !== null || model.request_json !== null || model.response_json !== null;
  return (
    <TimelineCard
      header={
        <>
          <ToneBadge tone="info">{t('invocations.invocationDetail.modelCall.badge')}</ToneBadge>
          <span className="text-sm font-medium">
            {model.provider}/{model.model}
          </span>
          <StateBadge state={model.state} />
        </>
      }
      extra={formatTime(model.created_at)}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>{t('invocations.invocationDetail.modelCall.attempt', { value: model.attempt })}</span>
        <span>{t('invocations.invocationDetail.modelCall.tokens', { value: formatNumber(model.total_tokens) })}</span>
        <span>
          {t('invocations.invocationDetail.modelCall.cacheRead', { value: formatNumber(model.cache_read_tokens) })}
        </span>
        <span>
          {t('invocations.invocationDetail.modelCall.cacheWrite', { value: formatNumber(model.cache_write_tokens) })}
        </span>
        <span>{t('invocations.invocationDetail.modelCall.cost', { value: formatCost(model.cost) })}</span>
        <span>
          {t('invocations.invocationDetail.modelCall.duration', { value: formatDuration(model.duration_ms) })}
        </span>
        {model.error_code !== null ? (
          <span className="text-destructive">
            {t('invocations.invocationDetail.modelCall.error', { code: model.error_code })}
          </span>
        ) : null}
      </div>
      {hasDetails ? (
        <LazyDetails
          summary={t('invocations.invocationDetail.modelCall.viewDetails')}
          summaryClassName="text-muted-foreground cursor-pointer text-xs"
          contentClassName="mt-2 space-y-2"
        >
          {model.error_detail !== null ? (
            <div>
              <p className="text-muted-foreground text-xs">
                {t('invocations.invocationDetail.modelCall.fullErrorDetails')}
              </p>
              <pre className="text-destructive mt-1 max-h-60 overflow-auto rounded border bg-muted/20 p-2 text-xs break-words whitespace-pre-wrap">
                {model.error_detail}
              </pre>
            </div>
          ) : null}
          {model.request_json !== null ? (
            <JsonViewer
              value={model.request_json}
              initiallyCollapsed
              title={t('invocations.invocationDetail.modelCall.requestPayload')}
            />
          ) : null}
          {model.response_json !== null ? (
            <JsonViewer
              value={model.response_json}
              initiallyCollapsed
              title={t('invocations.invocationDetail.modelCall.responseStatus')}
            />
          ) : null}
        </LazyDetails>
      ) : null}
      {model.request_json === null && model.response_json === null ? (
        <p className="text-muted-foreground text-xs">{t('invocations.invocationDetail.modelCall.rawUnavailable')}</p>
      ) : null}
    </TimelineCard>
  );
}

function TimelineItem({ event }: { readonly event: InvocationTimelineEvent }): React.ReactElement {
  const { t } = useTranslation();
  switch (event.kind) {
    case 'queued':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">{t('invocations.invocationDetail.timeline.queued')}</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'started':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">{t('invocations.invocationDetail.timeline.started')}</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'finished':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">{t('invocations.invocationDetail.timeline.finished')}</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'context_message':
      return <ContextMessageCard message={event.message} />;
    case 'model_call':
      return <ModelCallCard model={event.model} />;
    case 'tool_call':
      return <ToolCallCard tool={event.tool} send={event.linkedSend} />;
    case 'agent_message':
      return <AgentMessageCard message={event.message} />;
  }
}

function OverviewTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  const { t } = useTranslation();
  const events = buildInvocationTimeline(invocation);
  if (events.length === 0) {
    return <TabEmpty message={t('invocations.invocationDetail.emptyTimeline')} />;
  }
  return (
    <ol className="ml-1 space-y-4 border-l border-border pl-6">
      {events.map((event) => (
        <li key={timelineEventKey(event)} className="relative">
          <span
            className={cn(
              'absolute top-5 -left-[29px] size-2.5 rounded-full',
              event.kind === 'finished' ? 'bg-destructive' : 'bg-primary',
            )}
          />
          <TimelineItem event={event} />
        </li>
      ))}
    </ol>
  );
}

function SendArgumentsSummary({ argumentsJson }: { readonly argumentsJson: string }): React.ReactElement {
  const { t } = useTranslation();
  const parsed = parseSendArguments(argumentsJson);
  return (
    <div className="mb-2">
      <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.sendArguments.title')}</p>
      <KvList
        className="sm:grid-cols-2 lg:grid-cols-4"
        items={[
          { label: t('invocations.invocationDetail.sendArguments.kind'), value: <TextValue value={parsed.kind} /> },
          { label: t('invocations.invocationDetail.sendArguments.text'), value: <TextValue value={parsed.text} /> },
          {
            label: t('invocations.invocationDetail.sendArguments.stickerRef'),
            value: <TextValue value={parsed.sticker_ref} />,
          },
          {
            label: t('invocations.invocationDetail.sendArguments.replyToMessage'),
            value: <TextValue value={parsed.reply_to_message_id} />,
          },
        ]}
      />
    </div>
  );
}

function ToolCallsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const TOOL_CALL_COLUMNS: readonly ColumnSpec<ToolCallEntry>[] = [
    {
      key: 'tool',
      title: t('invocations.invocationDetail.toolColumns.tool'),
      render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{row.tool_name}</code>,
    },
    {
      key: 'call-id',
      title: t('invocations.invocationDetail.toolColumns.callId'),
      render: (row) => <MonoValue value={row.tool_call_id} />,
    },
    {
      key: 'state',
      title: t('invocations.invocationDetail.toolColumns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'side-effect',
      title: t('invocations.invocationDetail.toolColumns.sideEffect'),
      render: (row) => <YesNoBadge value={row.side_effect} />,
    },
    {
      key: 'error',
      title: t('invocations.invocationDetail.toolColumns.error'),
      render: (row) => <TextValue value={row.error_code} />,
    },
    {
      key: 'duration',
      title: t('invocations.invocationDetail.toolColumns.duration'),
      align: 'right',
      render: (row) => formatDuration(row.duration_ms),
    },
    {
      key: 'created',
      title: t('invocations.invocationDetail.toolColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TabContent count={invocation.tool_calls.length} message={t('invocations.invocationDetail.emptyToolCalls')}>
      <TableShell
        columns={TOOL_CALL_COLUMNS}
        data={invocation.tool_calls}
        rowKey={(row) => row.id}
        expandedRender={(row) => (
          <div className="space-y-3">
            {row.tool_name === 'send' ? <SendArgumentsSummary argumentsJson={row.arguments_json} /> : null}
            <div>
              <p className="text-muted-foreground mb-1 text-xs">
                {t('invocations.invocationDetail.toolCall.arguments')}
              </p>
              <JsonViewer value={row.arguments_json} />
            </div>
            <div>
              <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.toolCall.result')}</p>
              <JsonViewer value={row.result_text} />
            </div>
          </div>
        )}
      />
    </TabContent>
  );
}

function ModelCallsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const MODEL_CALL_COLUMNS: readonly ColumnSpec<ModelCallEntry>[] = [
    { key: 'role', title: t('invocations.invocationDetail.modelColumns.role'), render: (row) => row.role },
    { key: 'provider', title: t('invocations.invocationDetail.modelColumns.provider'), render: (row) => row.provider },
    { key: 'model', title: t('invocations.invocationDetail.modelColumns.model'), render: (row) => row.model },
    {
      key: 'attempt',
      title: t('invocations.invocationDetail.modelColumns.attempt'),
      align: 'right',
      render: (row) => String(row.attempt),
    },
    {
      key: 'tools',
      title: t('invocations.invocationDetail.modelColumns.toolsInRequest'),
      className: 'min-w-40',
      render: (row) =>
        row.tools === null ? (
          <TextValue value={null} />
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.tools.map((name) => (
              <code key={name} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {name}
              </code>
            ))}
          </div>
        ),
    },
    {
      key: 'state',
      title: t('invocations.invocationDetail.modelColumns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'input',
      title: t('invocations.invocationDetail.modelColumns.input'),
      align: 'right',
      render: (row) => formatNumber(row.input_tokens),
    },
    {
      key: 'output',
      title: t('invocations.invocationDetail.modelColumns.output'),
      align: 'right',
      render: (row) => formatNumber(row.output_tokens),
    },
    {
      key: 'cache-read',
      title: t('invocations.invocationDetail.modelColumns.cacheRead'),
      align: 'right',
      render: (row) => formatNumber(row.cache_read_tokens),
    },
    {
      key: 'cache-write',
      title: t('invocations.invocationDetail.modelColumns.cacheWrite'),
      align: 'right',
      render: (row) => formatNumber(row.cache_write_tokens),
    },
    {
      key: 'total',
      title: t('invocations.invocationDetail.modelColumns.total'),
      align: 'right',
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'cost',
      title: t('invocations.invocationDetail.modelColumns.cost'),
      align: 'right',
      render: (row) => formatCost(row.cost),
    },
    {
      key: 'duration',
      title: t('invocations.invocationDetail.modelColumns.duration'),
      align: 'right',
      render: (row) => formatDuration(row.duration_ms),
    },
    {
      key: 'error',
      title: t('invocations.invocationDetail.modelColumns.error'),
      render: (row) => <TextValue value={row.error_code} />,
    },
  ];
  return (
    <TabContent count={invocation.model_calls.length} message={t('invocations.invocationDetail.emptyModelCalls')}>
      <p className="text-muted-foreground text-xs">
        {t('invocations.invocationDetail.modelsTokensNote')} <code className="font-mono">provider_total_tokens</code>.
      </p>
      <p className="text-muted-foreground text-xs">{t('invocations.invocationDetail.modelsNote2')}</p>
      <TableShell
        columns={MODEL_CALL_COLUMNS}
        data={invocation.model_calls}
        rowKey={(row) => row.id}
        isExpandable={(row) => row.error_detail !== null || row.request_json !== null || row.response_json !== null}
        expandedRender={(row) => (
          <div className="space-y-3">
            {row.request_json !== null ? (
              <JsonViewer value={row.request_json} title={t('invocations.invocationDetail.modelCall.requestPayload')} />
            ) : null}
            {row.response_json !== null ? (
              <JsonViewer
                value={row.response_json}
                title={t('invocations.invocationDetail.modelCall.responseStatus')}
              />
            ) : null}
            {row.error_detail !== null ? (
              <div>
                <p className="text-muted-foreground mb-1 text-xs">
                  {t('invocations.invocationDetail.modelCall.fullErrorDetails')}
                </p>
                <pre className="max-h-60 overflow-auto rounded border bg-muted/20 p-2 text-xs break-words whitespace-pre-wrap">
                  {row.error_detail}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      />
    </TabContent>
  );
}

function TelegramSendsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const SEND_COLUMNS: readonly ColumnSpec<TelegramSendEntry>[] = [
    { key: 'kind', title: t('invocations.invocationDetail.sendColumns.kind'), render: (row) => row.kind },
    {
      key: 'state',
      title: t('invocations.invocationDetail.sendColumns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'message',
      title: t('invocations.invocationDetail.sendColumns.telegramMessage'),
      render: (row) => <TextValue value={row.telegram_message_id} />,
    },
    {
      key: 'tool-call',
      title: t('invocations.invocationDetail.sendColumns.toolCall'),
      render: (row) => <MonoValue value={row.tool_call_id} />,
    },
    {
      key: 'error',
      title: t('invocations.invocationDetail.sendColumns.error'),
      render: (row) => <TextValue value={row.error_code} />,
    },
    {
      key: 'created',
      title: t('invocations.invocationDetail.sendColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TabContent count={invocation.telegram_sends.length} message={t('invocations.invocationDetail.emptyTelegramSends')}>
      <TableShell
        columns={SEND_COLUMNS}
        data={invocation.telegram_sends}
        rowKey={(row) => row.id}
        expandedRender={(row) => (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.requestPayload')}</p>
            <JsonViewer value={row.request_json} />
          </div>
        )}
      />
    </TabContent>
  );
}

function AgentTranscriptTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const AGENT_COLUMNS: readonly ColumnSpec<AgentMessageEntry>[] = [
    {
      key: 'sequence',
      title: t('invocations.invocationDetail.agentColumns.sequence'),
      align: 'right',
      width: 60,
      render: (row) => String(row.sequence_no),
    },
    {
      key: 'role',
      title: t('invocations.invocationDetail.agentColumns.role'),
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <RoleBadge role={row.role} />
          {row.role === 'assistant' ? <PrivateReasoningTag /> : null}
        </div>
      ),
    },
    {
      key: 'text',
      title: t('invocations.invocationDetail.agentColumns.text'),
      className: 'min-w-64 max-w-2xl whitespace-normal',
      render: (row) => <p className="text-sm break-words whitespace-pre-wrap">{row.text}</p>,
    },
    {
      key: 'created',
      title: t('invocations.invocationDetail.agentColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <div className="space-y-3">
      <PrivateReasoningNote />
      <TabContent
        count={invocation.agent_messages.length}
        message={t('invocations.invocationDetail.emptyAgentMessages')}
      >
        <TableShell
          columns={AGENT_COLUMNS}
          data={invocation.agent_messages}
          rowKey={(row) => String(row.sequence_no)}
        />
      </TabContent>
    </div>
  );
}

function FrozenContextTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const CONTEXT_COLUMNS: readonly ColumnSpec<ContextMessageEntry>[] = [
    {
      key: 'section',
      title: t('invocations.invocationDetail.contextColumns.section'),
      render: (row) => <SectionBadge section={row.section} />,
    },
    {
      key: 'sequence',
      title: t('invocations.invocationDetail.contextColumns.sequence'),
      align: 'right',
      width: 60,
      render: (row) => String(row.sequence_no),
    },
    {
      key: 'message',
      title: t('invocations.invocationDetail.contextColumns.message'),
      render: (row) => (
        <Link
          to="/messages/$messageId"
          params={{ messageId: row.message_id }}
          className="font-mono text-xs break-all underline-offset-4 hover:underline"
        >
          {row.message_id}
        </Link>
      ),
    },
    {
      key: 'revision',
      title: t('invocations.invocationDetail.contextColumns.revision'),
      render: (row) => <MonoValue value={row.revision_id} />,
    },
    {
      key: 'sender',
      title: t('invocations.invocationDetail.contextColumns.sender'),
      render: (row) => {
        const sender = objectField(parseJsonObject(row.snapshot_json), 'sender');
        return (
          <div className="min-w-0 space-y-0.5">
            <TextValue value={stringField(sender, 'name') ?? stringField(sender, 'username')} />
            <CopyableValue label={t('common.telegramSenderId')} value={stringField(sender, 'id')} />
          </div>
        );
      },
    },
    {
      key: 'omitted',
      title: t('invocations.invocationDetail.contextColumns.omittedBefore'),
      align: 'right',
      render: (row) => String(row.omitted_before),
    },
  ];
  return (
    <TabContent
      count={invocation.context_messages.length}
      message={t('invocations.invocationDetail.emptyContextMessages')}
    >
      <TableShell
        columns={CONTEXT_COLUMNS}
        data={invocation.context_messages}
        rowKey={(row) => `${row.section}-${row.sequence_no}`}
        expandedRender={(row) => (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{t('invocations.invocationDetail.snapshot')}</p>
            <JsonViewer value={row.snapshot_json} />
          </div>
        )}
      />
    </TabContent>
  );
}

function TabEmpty({ message }: { readonly message: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{t('invocations.invocationDetail.nothingHere')}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function TabContent({
  count,
  message,
  children,
}: {
  readonly count: number;
  readonly message: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  if (count === 0) {
    return <TabEmpty message={message} />;
  }
  return <>{children}</>;
}

export function InvocationDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useQuery(invocationQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle={t('invocations.invocationDetail.notFound')}
        failedTitle={t('invocations.invocationDetail.loadFailed')}
        backTo="/invocations"
        backLabel={t('invocations.invocationDetail.backToToolSessions')}
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error(t('invocations.invocationDetail.dataMissing'))}
        notFoundTitle={t('invocations.invocationDetail.notFound')}
        failedTitle={t('invocations.invocationDetail.loadFailed')}
        backTo="/invocations"
        backLabel={t('invocations.invocationDetail.backToToolSessions')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <DetailHeader invocation={data} />
      <Card className="gap-0 py-4">
        <CardContent className="px-0 py-0">
          <Tabs defaultValue="overview">
            <TabsList className="mx-4 flex-wrap">
              <TabsTrigger value="overview">{t('invocations.invocationDetail.tabs.overview')}</TabsTrigger>
              <TabsTrigger value="tools">
                {t('invocations.invocationDetail.tabs.toolCalls', { count: data.tool_calls.length })}
              </TabsTrigger>
              <TabsTrigger value="models">
                {t('invocations.invocationDetail.tabs.modelCalls', { count: data.model_calls.length })}
              </TabsTrigger>
              <TabsTrigger value="sends">
                {t('invocations.invocationDetail.tabs.telegramSends', { count: data.telegram_sends.length })}
              </TabsTrigger>
              <TabsTrigger value="agent">
                {t('invocations.invocationDetail.tabs.agentTranscript', { count: data.agent_messages.length })}
              </TabsTrigger>
              <TabsTrigger value="context">
                {t('invocations.invocationDetail.tabs.frozenContext', { count: data.context_messages.length })}
              </TabsTrigger>
            </TabsList>
            <div className="p-4 md:p-6">
              <TabsContent value="overview">
                <OverviewTab invocation={data} />
              </TabsContent>
              <TabsContent value="tools">
                <ToolCallsTab invocation={data} />
              </TabsContent>
              <TabsContent value="models">
                <ModelCallsTab invocation={data} />
              </TabsContent>
              <TabsContent value="sends">
                <TelegramSendsTab invocation={data} />
              </TabsContent>
              <TabsContent value="agent">
                <AgentTranscriptTab invocation={data} />
              </TabsContent>
              <TabsContent value="context">
                <FrozenContextTab invocation={data} />
              </TabsContent>
            </div>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
