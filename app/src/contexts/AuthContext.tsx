// contexts/AuthContext.tsx
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { isMobile } from '@utils/platform';
import { authenticate } from 'tauri-plugin-web-auth-api';

const AUTH0_AUDIENCE = 'https://api.observer-ai.com';
const CALLBACK_SCHEME = 'observerai';
const MOBILE_CALLBACK_URL = `${CALLBACK_SCHEME}://callback`;

interface AuthUser {
  name?: string;
  email?: string;
  sub?: string;
  [key: string]: unknown;
}

export interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  login: () => Promise<void>;
  logout: () => void;
  getAccessToken: () => Promise<string | undefined>;
  refreshSession: () => Promise<string | undefined>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isMobileDevice] = useState<boolean>(() => {
    try {
      const mobile = isMobile();
      console.log('[AuthContext] Platform detection - isMobile:', mobile);
      return mobile;
    } catch (err) {
      console.warn('[AuthContext] Platform detection failed, assuming web:', err);
      return false;
    }
  });

  const auth0 = useAuth0();

  const login = useCallback(async () => {
    if (!isMobileDevice) {
      return auth0.loginWithRedirect();
    }

    console.log('[AuthContext] Starting mobile login flow');
    await auth0.loginWithRedirect({
      authorizationParams: {
        redirect_uri: MOBILE_CALLBACK_URL,
        audience: AUTH0_AUDIENCE,
        scope: 'openid profile email offline_access',
      },
      openUrl: async (url) => {
        console.log('[AuthContext] Opening web auth session...');
        const result = await authenticate({
          url: url,
          callbackScheme: CALLBACK_SCHEME,
        });

        console.log('[AuthContext] Mobile auth completed, handling callback...');
        await auth0.handleRedirectCallback(result.callbackUrl);
      },
    });
  }, [isMobileDevice, auth0]);

  const logout = useCallback(() => {
    // Clear legacy token key from the old custom auth flow
    localStorage.removeItem('observer_auth_tokens');

    if (isMobileDevice) {
      console.log('[AuthContext] Mobile logout - clearing local session');
      auth0.logout({ openUrl: false });
    } else {
      auth0.logout({ logoutParams: { returnTo: window.location.origin } });
    }
  }, [isMobileDevice, auth0]);

  const getAccessToken = useCallback(async (): Promise<string | undefined> => {
    try {
      return await auth0.getAccessTokenSilently({
        authorizationParams: { audience: AUTH0_AUDIENCE },
      });
    } catch {
      return undefined;
    }
  }, [auth0]);

  const refreshSession = useCallback(async (): Promise<string | undefined> => {
    try {
      console.log('[AuthContext] Forcing token refresh...');
      const token = await auth0.getAccessTokenSilently({
        authorizationParams: { audience: AUTH0_AUDIENCE },
        cacheMode: 'off',
      });
      console.log('[AuthContext] Token refreshed successfully');
      return token;
    } catch (err) {
      console.error('[AuthContext] Token refresh failed:', err);
      throw err;
    }
  }, [auth0]);

  const value: AuthContextType = {
    isAuthenticated: auth0.isAuthenticated,
    isLoading: auth0.isLoading,
    user: auth0.user as AuthUser | null,
    login,
    logout,
    getAccessToken,
    refreshSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Mock auth for local dev
export function useMockAuth(): AuthContextType {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: { name: 'Local Dev User', email: 'dev@local.host' },
    login: async () => { console.log('[MockAuth] Login called'); },
    logout: () => { console.log('[MockAuth] Logout called'); },
    getAccessToken: async () => 'mock_token',
    refreshSession: async () => {
      console.log('[MockAuth] Refresh session called');
      return 'mock_token';
    },
  };
}
