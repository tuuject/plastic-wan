import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  ApiError,
  type Credentials,
  createFirstAdmin,
  login,
  passkeyLoginOptions,
  passkeyLoginVerify,
} from '@/lib/api';
import { isWebAuthnAvailable, passkeyErrorMessage } from '@/lib/passkeys';
import { sessionQuery } from '@/lib/queries';
import { useTranslation } from 'react-i18next';

export function LoginForm({ passkeysEnabled }: { readonly passkeysEnabled: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const webAuthnAvailable = isWebAuthnAvailable();

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
    },
  });

  const passkeyMutation = useMutation({
    // Discoverable passkeys: the server's options carry no username, so the
    // authenticator picks the credential for this origin.
    mutationFn: async () => {
      const options = await passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      return passkeyLoginVerify(response);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(passkeyErrorMessage(error));
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  const onSubmit = (data: Credentials) => {
    setFailure(null);
    loginMutation.mutate(data);
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('pages.auth.loginTitle')}</CardTitle>
          <CardDescription>{t('pages.auth.loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('pages.auth.username')}</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                {...register('username', {
                  required: t('pages.auth.usernameRequired'),
                  pattern: {
                    value: /^[A-Za-z0-9._-]{3,32}$/,
                    message: t('pages.auth.usernamePattern'),
                  },
                })}
              />
              {errors.username && <p className="text-destructive text-sm">{errors.username.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('pages.auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password', { required: t('pages.auth.passwordRequired') })}
              />
              {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
            </div>
            {loginMutation.isError && failure !== null && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('pages.auth.signingIn') : t('pages.auth.signIn')}
            </Button>
          </form>
          {passkeysEnabled ? (
            <div className="mt-4 space-y-3">
              <Separator />
              {webAuthnAvailable ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={passkeyMutation.isPending}
                    onClick={() => {
                      setFailure(null);
                      passkeyMutation.mutate();
                    }}
                  >
                    {passkeyMutation.isPending ? t('pages.auth.passkeySigningIn') : t('pages.auth.passkeySignIn')}
                  </Button>
                  {passkeyMutation.isError && failure !== null && (
                    <p role="alert" className="text-destructive text-sm">
                      {failure}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground text-sm">{t('pages.auth.passkeyUnavailable')}</p>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export function SetupForm(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: createFirstAdmin,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  const onSubmit = (data: Credentials) => {
    setFailure(null);
    setupMutation.mutate(data);
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('pages.auth.setupTitle')}</CardTitle>
          <CardDescription>{t('pages.auth.setupDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('pages.auth.username')}</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                {...register('username', {
                  required: t('pages.auth.usernameRequired'),
                  pattern: {
                    value: /^[A-Za-z0-9._-]{3,32}$/,
                    message: t('pages.auth.usernamePattern'),
                  },
                })}
              />
              {errors.username && <p className="text-destructive text-sm">{errors.username.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('pages.auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register('password', {
                  required: t('pages.auth.passwordRequired'),
                  minLength: { value: 12, message: t('pages.auth.passwordMinLength') },
                })}
              />
              {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
            </div>
            {failure && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('pages.auth.creating') : t('pages.auth.createAccount')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
