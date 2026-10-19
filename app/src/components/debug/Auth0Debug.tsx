import React from 'react';
import { useAuth0 } from '@auth0/auth0-react';

export const Auth0Debug = () => {
  const {
    isLoading,
    isAuthenticated,
    error,
    user,
    getAccessTokenSilently,
  } = useAuth0();

  const [token, setToken] = React.useState<string | null>(null);
  const [tokenError, setTokenError] = React.useState<string | null>(null);

  const fetchToken = async () => {
    try {
      const accessToken = await getAccessTokenSilently();
      setToken(accessToken ?? null);
      setTokenError(null);
    } catch (err) {
      setToken(null);
      setTokenError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed top-20 right-4 p-4 bg-white shadow-lg rounded-md z-50 max-w-md overflow-auto max-h-[80vh]">
      <h2 className="text-lg font-bold mb-2 border-b pb-2">Auth0 Debug Info</h2>
      
      <div className="space-y-2 mb-4">
        <div><span className="font-medium">Loading:</span> {isLoading ? 'true' : 'false'}</div>
        <div><span className="font-medium">Authenticated:</span> {isAuthenticated ? 'true' : 'false'}</div>
        {error && (
          <div className="text-red-600">
            <span className="font-medium">Error:</span> {error.message}
          </div>
        )}
      </div>

      {user && (
        <div className="mb-4">
          <h3 className="font-medium mb-1">User Info:</h3>
          <pre className="bg-gray-100 p-2 rounded text-xs overflow-x-auto">
            {JSON.stringify(user, null, 2)}
          </pre>
        </div>
      )}

      <div className="mb-3">
        <button 
          onClick={fetchToken} 
          className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          disabled={!isAuthenticated}
        >
          Test Get Token
        </button>
      </div>

      {token && (
        <div className="mb-4">
          <h3 className="font-medium mb-1">Access Token:</h3>
          <div className="bg-gray-100 p-2 rounded text-xs overflow-x-auto break-all">
            {token}
          </div>
        </div>
      )}

      {tokenError && (
        <div className="text-red-600">
          <span className="font-medium">Token Error:</span> {tokenError}
        </div>
      )}

      <div className="mt-4 pt-2 border-t text-sm">
        <p>Add this component to your App for debugging:</p>
        <pre className="bg-gray-100 p-2 rounded text-xs mt-1">
          {`import { Auth0Debug } from './path/to/Auth0Debug';\n\n// Inside your component:\n<Auth0Debug />`}
        </pre>
      </div>
    </div>
  );
};

export default Auth0Debug;
