import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  getChats,
  getConfigStatus,
  getConversationContext,
  getDeveloperSettings,
  getInvocation,
  getMessage,
  getOverview,
  getProviderPresets,
  getProviders,
  getSession,
  getUsage,
  type ListFilters,
  listAlarms,
  listApiKeys,
  listBotAdmins,
  listConversationContexts,
  listInvocations,
  listMemories,
  listMemoryChats,
  listMessages,
  listStickerSets,
  listStickers,
  type Page,
} from './api.ts';

export const PAGE_SIZE = 25;

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: getSession,
  staleTime: 0,
});

export const overviewQuery = queryOptions({
  queryKey: ['overview'],
  queryFn: getOverview,
});

export function usageQuery(days: number) {
  return queryOptions({
    queryKey: ['usage', days],
    queryFn: () => getUsage(days),
  });
}

export const stickerSetsQuery = queryOptions({
  queryKey: ['sticker-sets'],
  queryFn: listStickerSets,
});

function infiniteList<T>(key: string, list: (filters: ListFilters) => Promise<Page<T>>, filters: ListFilters) {
  return infiniteQueryOptions({
    queryKey: [key, filters],
    queryFn: ({ pageParam }) => list({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function invocationsQuery(filters: ListFilters) {
  return infiniteList('invocations', listInvocations, filters);
}

export function messagesQuery(filters: ListFilters) {
  return infiniteList('messages', listMessages, filters);
}

export function stickersQuery(filters: ListFilters) {
  return infiniteList('stickers', listStickers, filters);
}

export function memoriesQuery(filters: ListFilters) {
  return infiniteList('memories', listMemories, filters);
}

export function alarmsQuery(filters: ListFilters) {
  return infiniteList('alarms', listAlarms, filters);
}

export function conversationContextsQuery(filters: ListFilters) {
  return infiniteList('contexts', listConversationContexts, filters);
}

export function conversationContextQuery(conversationId: string) {
  return queryOptions({
    queryKey: ['context', conversationId],
    queryFn: () => getConversationContext(conversationId),
  });
}

export const memoryChatsQuery = queryOptions({
  queryKey: ['memory-chats'],
  queryFn: listMemoryChats,
});

export const apiKeysQuery = queryOptions({
  queryKey: ['api-keys'],
  queryFn: listApiKeys,
  staleTime: 0,
});

export const adminsQuery = queryOptions({
  queryKey: ['admins'],
  queryFn: listBotAdmins,
});

export const chatsQuery = queryOptions({
  queryKey: ['chats'],
  queryFn: getChats,
  staleTime: 0,
});

export const providersQuery = queryOptions({
  queryKey: ['providers'],
  queryFn: getProviders,
  // The page writes and reads the same resource, so a cached view goes stale on
  // every write; the mutations invalidate it explicitly.
  staleTime: 0,
});

export const providerPresetsQuery = queryOptions({
  queryKey: ['provider-presets'],
  queryFn: getProviderPresets,
});

export const configStatusQuery = queryOptions({
  queryKey: ['config-status'],
  queryFn: getConfigStatus,
});

export const developerQuery = queryOptions({
  queryKey: ['developer'],
  queryFn: getDeveloperSettings,
  staleTime: 0,
});

export function invocationQuery(id: string) {
  return queryOptions({
    queryKey: ['invocation', id],
    queryFn: () => getInvocation(id),
  });
}

export function messageQuery(id: string) {
  return queryOptions({
    queryKey: ['message', id],
    queryFn: () => getMessage(id),
  });
}
