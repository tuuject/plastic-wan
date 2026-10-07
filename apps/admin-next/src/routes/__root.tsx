import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, type ErrorComponentProps, Outlet, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ApiError, logout, type SessionState } from '@/lib/api';
import { sessionQuery } from '@/lib/queries';
import { LoginForm, SetupForm } from '@/pages/auth';

const UNAUTHENTICATED_SESSION: SessionState = {
  setup_required: false,
  authenticated: false,
  username: null,
  expires_at: null,
  passkeys_enabled: false,
  has_password: null,
};

interface RouterContext {
  readonly queryClient: QueryClient;
}

function AuthGate(): React.ReactNode {
  const { data, isPending, error } = useQuery(sessionQuery);

  if (isPending) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    const message = error instanceof ApiError ? `${error.code}: ${error.message}` : 'Session check failed';
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">Request failed</p>
          <p className="text-muted-foreground text-sm">{message}</p>
        </div>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.setup_required) {
    return <SetupForm />;
  }
  if (!data.authenticated) {
    // The session is the single source for whether passkeys are configured:
    // a server built without `admin.public_url` never shows the passkey entry.
    return <LoginForm passkeysEnabled={data.passkeys_enabled} />;
  }

  return (
    <SidebarProvider>
      <AdminShell username={data.username ?? 'admin'} />
    </SidebarProvider>
  );
}

function isSessionQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === sessionQuery.queryKey[0];
}

function AdminShell({ username }: { readonly username: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      // Order matters: cancel in-flight protected fetches, drop every cached
      // entry EXCEPT the session query, then force the session query to
      // refetch (the same mechanism the global 401 handler uses) so the
      // AuthGate re-evaluates to `authenticated: false` before navigating
      // back to the root. clear()+setQueryData alone does not reliably
      // re-render the gate (the removed query's observer is not re-notified
      // by setQueryData), which is why the refetch is driven explicitly.
      queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => !isSessionQueryKey(query.queryKey) });
      queryClient.setQueryData(sessionQuery.queryKey, UNAUTHENTICATED_SESSION);
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      await navigate({ to: '/' });
    },
    onError: async () => {
      // Local sign-out must not leave the user on a dead shell or an error
      // screen even when the logout request itself failed: drop protected
      // data and set the (still-live) session query to unauthenticated so the
      // AuthGate renders the login form immediately, without needing another
      // network round-trip.
      queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => !isSessionQueryKey(query.queryKey) });
      queryClient.setQueryData(sessionQuery.queryKey, UNAUTHENTICATED_SESSION);
      await navigate({ to: '/' });
    },
  });

  return (
    <>
      <AppSidebar username={username} onSignOut={() => signOut.mutate()} />
      <SidebarInset className="min-w-0">
        <Header />
        <main className="flex flex-1 flex-col p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </>
  );
}

/**
 * Fallback for errors that escape into the router. API failures are handled
 * per-page (useQuery error states) or by the global 401 handler in
 * lib/query-client.ts, so this only catches unexpected render/route errors.
 */
function RouteErrorFallback({ error }: ErrorComponentProps): React.ReactElement {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-destructive">Something went wrong</CardTitle>
          <CardDescription>The admin panel could not render this screen.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground break-words text-sm">{message}</p>
          <Button type="button" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: AuthGate,
  errorComponent: RouteErrorFallback,
});
