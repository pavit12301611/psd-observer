import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@contexts/AuthContext';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { Logger } from '@utils/logging';

/**
 * Seat invite landing page: /join?token=xyz
 *
 * Order matters. The seat is written into Auth0 app_metadata by /orgs/claim,
 * and the JWT only picks it up on the next mint — so the token refresh has to
 * come after the claim, not before, or the user lands in the app still Free.
 */
export function JoinOrgPage() {
  const { isAuthenticated, isLoading, login, getAccessToken, refreshSession } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [status, setStatus] = useState<'working' | 'success' | 'error'>('working');
  const [message, setMessage] = useState('Accepting your invite...');
  const [orgName, setOrgName] = useState<string | null>(null);
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (isLoading) return;

    if (!token) {
      setStatus('error');
      setMessage('This link is missing its invite code. Ask your admin to resend it.');
      return;
    }

    // Not logged in yet — send them through Auth0 and come back to this exact URL.
    if (!isAuthenticated) {
      login();
      return;
    }

    if (hasRunRef.current) return;
    hasRunRef.current = true;

    (async () => {
      try {
        const accessToken = await getAccessToken();
        const response = await fetch('https://api.observer-ai.com/orgs/claim', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          Logger.error('JOIN_ORG', 'Claim failed', { status: response.status, data });
          setStatus('error');
          setMessage(data.detail || 'We could not accept this invite.');
          return;
        }

        // Claim succeeded — now mint a token that carries the new entitlement.
        await refreshSession();

        setOrgName(data.org_name || null);
        setStatus('success');
        setTimeout(() => navigate('/team'), 1500);
      } catch (error) {
        Logger.error('JOIN_ORG', 'Unexpected error claiming invite', { error });
        setStatus('error');
        setMessage('Something went wrong accepting your invite. Please try again.');
      }
    })();
  }, [isLoading, isAuthenticated, token, login, getAccessToken, refreshSession, navigate]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-gray-50 to-gray-100">
      <div className="p-10 bg-white rounded-2xl shadow-lg max-w-md w-full mx-4 text-center">
        <div className="flex justify-center mb-5">
          {status === 'working' && (
            <div className="h-16 w-16 rounded-full bg-blue-50 flex items-center justify-center">
              <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
            </div>
          )}
          {status === 'success' && (
            <div className="h-16 w-16 rounded-full bg-green-50 flex items-center justify-center">
              <CheckCircle className="h-8 w-8 text-green-500" />
            </div>
          )}
          {status === 'error' && (
            <div className="h-16 w-16 rounded-full bg-red-50 flex items-center justify-center">
              <AlertCircle className="h-8 w-8 text-red-500" />
            </div>
          )}
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          {status === 'success' ? 'You’re in!' : status === 'error' ? 'Invite problem' : 'Joining your team'}
        </h1>

        {status === 'working' && <p className="text-gray-500 text-sm">{message}</p>}

        {status === 'success' && (
          <p className="text-green-600 font-medium text-sm">
            {orgName ? `Welcome to ${orgName} on Observer AI.` : 'Your seat is active.'}
          </p>
        )}

        {status === 'error' && (
          <>
            <p className="text-gray-500 text-sm mb-6">{message}</p>
            <button
              onClick={() => navigate('/')}
              className="px-5 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-xl hover:bg-gray-200 transition-colors"
            >
              Go to Observer
            </button>
          </>
        )}
      </div>
    </div>
  );
}
