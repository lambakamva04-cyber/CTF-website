import type {
  AccountAction,
  AdminAccountsResponse,
  AdminActivityResponse,
  AdminNoticesResponse,
  AdminOverview,
  AdminPeriod,
  ApiErrorBody,
  AuthMethodsResponse,
  BackupCodesResponse,
  CallDetail,
  CallsResponse,
  CreatedTeamMember,
  LiveResponse,
  LoginResponse,
  MeResponse,
  MetricsResponse,
  OrgAction,
  Period,
  SignupStartResponse,
  StepUpResponse,
  TakeoverResponse,
  TeamMember,
  TeamResponse,
  TotpEnrollment,
  TranscriptResponse,
  TwoFactorChallenge,
  TwoFactorStatus,
  UserRole,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True for the network/5xx failures that are worth retrying automatically. */
  get isTransient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // The session lives in a same-site cookie; nothing is kept in JS.
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errorBody = (payload ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(
      response.status,
      errorBody.error ?? 'http_error',
      errorBody.message ?? 'Something went wrong. Please try again.',
      errorBody.retryAfter,
    );
  }

  return payload as T;
}

export const api = {
  me: (signal?: AbortSignal) => request<MeResponse>('/api/me', { signal }),

  authMethods: (signal?: AbortSignal) =>
    request<AuthMethodsResponse>('/api/auth/methods', { signal }),

  startSignup: (orgName: string, note: string) =>
    request<SignupStartResponse>('/api/auth/signup/start', {
      method: 'POST',
      body: { orgName, note, accept: true },
    }),

  acceptTerms: () => request<void>('/api/auth/accept-terms', { method: 'POST' }),

  // --- CTF admin console --------------------------------------------------
  adminOverview: (period: AdminPeriod, signal?: AbortSignal) =>
    request<AdminOverview>(`/api/platform/overview?period=${period}`, { signal }),

  adminAccounts: (signal?: AbortSignal) =>
    request<AdminAccountsResponse>('/api/platform/accounts', { signal }),

  adminActivity: (before: number | null, signal?: AbortSignal) =>
    request<AdminActivityResponse>(
      before ? `/api/platform/activity?before=${before}` : '/api/platform/activity',
      { signal },
    ),

  adminNotices: (signal?: AbortSignal) =>
    request<AdminNoticesResponse>('/api/platform/notifications', { signal }),

  markAdminNoticesRead: () =>
    request<void>('/api/platform/notifications/read', { method: 'POST' }),

  adminStepUp: (code: string) =>
    request<StepUpResponse>('/api/platform/step-up', { method: 'POST', body: { code } }),

  adminOrgAction: (orgId: string, action: OrgAction, reason: string) =>
    request<void>(`/api/platform/organizations/${encodeURIComponent(orgId)}`, {
      method: 'POST',
      body: { action, reason },
    }),

  adminAccountAction: (userId: string, action: AccountAction, reason: string) =>
    request<void>(`/api/platform/accounts/${encodeURIComponent(userId)}`, {
      method: 'POST',
      body: { action, reason },
    }),

  team: (signal?: AbortSignal) => request<TeamResponse>('/api/users', { signal }),

  createTeamMember: (member: {
    email: string;
    name: string;
    role: UserRole;
    phone?: string;
    /** Defaults to Google, which needs no password and so no hashing. */
    signInMethod?: 'google' | 'password';
  }) => request<CreatedTeamMember>('/api/users', { method: 'POST', body: member }),

  updateTeamMember: (
    userId: string,
    changes: { role?: UserRole; disabled?: boolean; name?: string; phone?: string | null },
  ) =>
    request<TeamMember>(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: changes,
    }),

  resetTeamMemberPassword: (userId: string) =>
    request<CreatedTeamMember>(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { resetPassword: true },
    }),

  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: { email, password } }),

  /** Answers a second-factor challenge; a session cookie comes back with it. */
  verifyTwoFactor: (challengeId: string, input: { code?: string; backupCode?: string }) =>
    request<MeResponse>('/api/auth/2fa/verify', {
      method: 'POST',
      body: { challengeId, ...input },
    }),

  resendTwoFactorCode: (challengeId: string) =>
    request<TwoFactorChallenge>('/api/auth/2fa/resend', {
      method: 'POST',
      body: { challengeId },
    }),

  twoFactorStatus: (signal?: AbortSignal) => request<TwoFactorStatus>('/api/auth/2fa', { signal }),

  startTotpEnrollment: () =>
    request<TotpEnrollment>('/api/auth/2fa/totp/start', { method: 'POST' }),

  confirmTotpEnrollment: (code: string) =>
    request<BackupCodesResponse>('/api/auth/2fa/totp/confirm', { method: 'POST', body: { code } }),

  enableEmailFactor: () =>
    request<BackupCodesResponse>('/api/auth/2fa/email/enable', { method: 'POST' }),

  disableTwoFactor: (code: string) =>
    request<{ ok: true }>('/api/auth/2fa/disable', { method: 'POST', body: { code } }),

  regenerateBackupCodes: () =>
    request<BackupCodesResponse>('/api/auth/2fa/backup-codes', { method: 'POST' }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  liveCall: (signal?: AbortSignal) => request<LiveResponse>('/api/calls/live', { signal }),

  transcript: (callId: string, after: number, signal?: AbortSignal) =>
    request<TranscriptResponse>(
      `/api/calls/${encodeURIComponent(callId)}/transcript?after=${after}`,
      { signal },
    ),

  call: (callId: string, signal?: AbortSignal) =>
    request<CallDetail>(`/api/calls/${encodeURIComponent(callId)}`, { signal }),

  calls: (filter: string, cursor: string | null, signal?: AbortSignal) => {
    const params = new URLSearchParams({ filter, limit: '20' });
    if (cursor) params.set('cursor', cursor);
    return request<CallsResponse>(`/api/calls?${params.toString()}`, { signal });
  },

  metrics: (period: Period, signal?: AbortSignal) =>
    request<MetricsResponse>(`/api/metrics?period=${period}`, { signal }),

  takeover: (callId: string, number?: string) =>
    request<TakeoverResponse>(`/api/calls/${encodeURIComponent(callId)}/takeover`, {
      method: 'POST',
      body: number ? { number } : {},
    }),

  endCall: (callId: string) =>
    request<CallDetail>(`/api/calls/${encodeURIComponent(callId)}/end`, { method: 'POST' }),
};
