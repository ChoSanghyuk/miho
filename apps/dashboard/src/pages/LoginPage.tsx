import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';

export function LoginPage() {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const login = useMutation({ mutationFn: () => api.login(token), onSuccess: () => qc.invalidateQueries() });

  return (
    <div className="shell login">
      <p className="eyebrow">MIHO</p>
      <h1>Sign in</h1>
      <p className="lede">Paste the owner token to open the dashboard.</p>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Owner token (ORCH_OWNER_TOKEN)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoFocus
        />
        <button disabled={login.isPending}>Sign in</button>
      </form>
      {login.error && <p className="error">{login.error.message}</p>}
    </div>
  );
}
